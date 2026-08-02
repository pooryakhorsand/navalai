# resistance/yacht/views.py
import base64
import gzip
import hashlib
import json
import math
import threading
from collections import OrderedDict

import numpy as np
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from .engine import YachtCalculation, yacht_calculate_resistances

try:
    import orjson
except Exception:
    orjson = None


MAX_BODY_BYTES = 128 * 1024
MAX_RETURN_POINTS = 9_000
RESPONSE_CACHE_SIZE = 32

_RESPONSE_CACHE = OrderedDict()
_RESPONSE_CACHE_LOCK = threading.RLock()


def _json_dumps(obj):
    if orjson is not None:
        return orjson.dumps(obj)
    return json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False
    ).encode("utf-8")


def _cache_get_entry(key):
    with _RESPONSE_CACHE_LOCK:
        entry = _RESPONSE_CACHE.get(key)
        if entry is not None:
            _RESPONSE_CACHE.move_to_end(key)
        return entry


def _cache_set_raw(key, raw_bytes):
    with _RESPONSE_CACHE_LOCK:
        _RESPONSE_CACHE[key] = {
            "raw": raw_bytes,
            "gzip": None,
        }
        _RESPONSE_CACHE.move_to_end(key)
        while len(_RESPONSE_CACHE) > RESPONSE_CACHE_SIZE:
            _RESPONSE_CACHE.popitem(last=False)
        return _RESPONSE_CACHE[key]


def _client_accepts_gzip(request):
    enc = request.META.get("HTTP_ACCEPT_ENCODING", "")
    return "gzip" in enc.lower()


def _response_from_entry(entry, request, status=200):
    raw = entry["raw"]
    use_gzip = _client_accepts_gzip(request) and len(raw) > 4096

    if use_gzip:
        gz = entry.get("gzip")
        if gz is None:
            gz = gzip.compress(raw, compresslevel=1)
            with _RESPONSE_CACHE_LOCK:
                entry["gzip"] = gz
        resp = HttpResponse(gz, status=status, content_type="application/json")
        resp["Content-Encoding"] = "gzip"
        resp["Vary"] = "Accept-Encoding"
        resp["Content-Length"] = str(len(gz))
    else:
        resp = HttpResponse(raw, status=status, content_type="application/json")
        resp["Content-Length"] = str(len(raw))

    resp["Cache-Control"] = "no-store, max-age=0"
    return resp


def _json_error(message, status=400, errors=None):
    payload = {
        "success": False,
        "message": message,
    }
    if errors is not None:
        payload["errors"] = errors
    raw = _json_dumps(payload)
    resp = HttpResponse(raw, status=status, content_type="application/json")
    resp["Cache-Control"] = "no-store, max-age=0"
    resp["Content-Length"] = str(len(raw))
    return resp


def _as_float(data, key, default=None, required=False):
    if key not in data:
        if required:
            raise ValueError(f"Missing required field: {key}")
        return default
    value = data[key]
    if isinstance(value, bool):
        raise ValueError(f"Invalid numeric field: {key}")
    try:
        f = float(value)
    except Exception:
        raise ValueError(f"Invalid numeric field: {key}")
    if not math.isfinite(f):
        raise ValueError(f"Non-finite numeric field: {key}")
    return f


def _as_int(data, key, default=1, min_value=1, max_value=10_000):
    if key not in data:
        return default
    try:
        value = int(float(data[key]))
    except Exception:
        raise ValueError(f"Invalid integer field: {key}")
    if value < min_value:
        value = min_value
    elif value > max_value:
        value = max_value
    return value


def _safe_float(value):
    if value is None:
        return None
    try:
        f = float(value)
    except Exception:
        return None
    if not math.isfinite(f):
        return None
    return f


def _select_indices(n, stride):
    if n <= 0:
        return np.empty(0, dtype=np.int64)
    stride = max(1, int(stride))
    idx = np.arange(0, n, stride, dtype=np.int64)
    if idx.size == 0 or idx[-1] != n - 1:
        idx = np.concatenate((idx, np.array([n - 1], dtype=np.int64)))
    return idx


def _encode_f32_base64(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def _build_series_payload(
    response_format,
    output_stride,
    froude_series,
    residuary_series,
    friction_series,
    total_series,
):
    arrays = {
        "froude_series": froude_series,
        "residuary_series": residuary_series,
        "friction_series": friction_series,
        "total_series": total_series,
    }
    n = int(froude_series.shape[0])

    if n > 0 and math.ceil(n / output_stride) > MAX_RETURN_POINTS:
        output_stride = int(math.ceil(n / MAX_RETURN_POINTS))

    idx = _select_indices(n, output_stride)
    returned_n = int(idx.shape[0])

    if response_format == "compact":
        payload = {
            "_format": "f32-base64-v1",
            "_length": returned_n,
        }
        for key, arr in arrays.items():
            payload[key] = _encode_f32_base64(arr[idx])
    else:
        payload = {}
        for key, arr in arrays.items():
            selected = np.asarray(arr[idx], dtype=np.float64)
            payload[key] = np.round(selected, 6).tolist()

    meta = {
        "sample_count_solver": n,
        "sample_count_returned": returned_n,
        "output_stride": int(output_stride),
        "max_return_points": MAX_RETURN_POINTS,
    }
    return payload, meta


def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    L = _as_float(data, "L", required=True)
    B = _as_float(data, "B", required=True)
    T = _as_float(data, "T", required=True)

    if L <= 0:
        raise ValueError("L must be positive.")
    if B <= 0:
        raise ValueError("B must be positive.")
    if T <= 0:
        raise ValueError("T must be positive.")

    # Optional: if omitted, YachtCalculation will derive them
    displacement = _as_float(data, "displacement", default=None)
    lcb = _as_float(data, "lcb", default=None)
    Pc = _as_float(data, "Pc", default=None)

    response_format = str(data.get("response_format", "json")).lower().strip()
    if response_format not in ("json", "compact"):
        response_format = "json"

    output_stride = _as_int(
        data,
        "output_stride",
        default=1,
        min_value=1,
        max_value=500
    )

    return {
        "L": L,
        "B": B,
        "T": T,
        "displacement": displacement,
        "lcb": lcb,
        "Pc": Pc,
        "response_format": response_format,
        "output_stride": output_stride,
    }


@method_decorator(csrf_exempt, name="dispatch")
class YachtResistanceView(View):
    """
    Optimized yacht resistance endpoint.

    POST /maneuver/yacht/

    Response envelope:
    {
      "success": true,
      "data": {...},
      "message": "..."
    }
    """
    http_method_names = ["post", "options"]

    def options(self, request, *args, **kwargs):
        resp = HttpResponse(status=204)
        resp["Allow"] = "POST, OPTIONS"
        return resp

    def post(self, request, *args, **kwargs):
        raw_body = request.body or b"{}"

        if len(raw_body) > MAX_BODY_BYTES:
            return _json_error("Request body is too large.", status=413)

        cache_key = hashlib.blake2b(raw_body, digest_size=16).hexdigest()
        cached = _cache_get_entry(cache_key)

        if cached is not None:
            return _response_from_entry(cached, request, status=200)

        try:
            data = json.loads(raw_body)
        except Exception:
            return _json_error("Invalid JSON body.", status=400)

        try:
            parsed = _parse_payload(data)
        except ValueError as exc:
            return _json_error(str(exc), status=400)

        try:
            L = parsed["L"]
            B = parsed["B"]
            T = parsed["T"]

            # Derive missing parameters via YachtCalculation
            need_derive = (
                parsed["displacement"] is None
                or parsed["lcb"] is None
                or parsed["Pc"] is None
            )

            if need_derive:
                yacht = YachtCalculation(L, B, T)
                yacht_params = yacht.get_results()
                displacement = parsed["displacement"] if parsed["displacement"] is not None else yacht_params["displacement"]
                lcb = parsed["lcb"] if parsed["lcb"] is not None else yacht_params["lcb"]
                Pc = parsed["Pc"] if parsed["Pc"] is not None else yacht_params["Pc"]
            else:
                displacement = parsed["displacement"]
                lcb = parsed["lcb"]
                Pc = parsed["Pc"]
                # Still build a param dict for the response
                yacht = YachtCalculation(L, B, T)
                yacht_params = yacht.get_results()
                yacht_params["displacement"] = displacement
                yacht_params["lcb"] = lcb
                yacht_params["Pc"] = Pc

            res = yacht_calculate_resistances(
                L=L,
                B=B,
                T=T,
                lcb=lcb,
                Pc=Pc,
                displacement=displacement,
            )

            series_payload, series_meta = _build_series_payload(
                parsed["response_format"],
                parsed["output_stride"],
                res["froude_series"],
                res["residuary_series"],
                res["friction_series"],
                res["total_series"],
            )

            # Simple metrics derived from full arrays
            total_arr = res["total_series"]
            max_total_idx = int(np.argmax(total_arr))

            metrics = {
                "max_total_resistance": _safe_float(total_arr[max_total_idx]),
                "froude_at_max_total": _safe_float(res["froude_series"][max_total_idx]),
                "max_residuary_resistance": _safe_float(np.max(res["residuary_series"])),
            }

            output_payload = {
                "success": True,
                "data": {
                    "parameters": yacht_params,
                    "metrics": metrics,
                    "resistances": series_payload,
                    "series_meta": series_meta,
                },
                "message": "Yacht resistance calculation completed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)

            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Resistance processing fault: {str(exc)}",
                status=500,
            )