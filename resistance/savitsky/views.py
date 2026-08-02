# resistance/savitsky/views.py
import gzip
import hashlib
import json
import math
import threading
from collections import OrderedDict

from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from .engine import SavitskyModel

try:
    import orjson
except Exception:
    orjson = None


MAX_BODY_BYTES = 64 * 1024
RESPONSE_CACHE_SIZE = 128

_RESPONSE_CACHE = OrderedDict()
_RESPONSE_CACHE_LOCK = threading.RLock()


def _json_dumps(obj):
    if orjson is not None:
        return orjson.dumps(obj)

    return json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
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
    use_gzip = _client_accepts_gzip(request) and len(raw) > 1024

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


def _as_int(data, key, default=1, min_value=0, max_value=10):
    if key not in data:
        return default

    value = data[key]

    if isinstance(value, bool):
        raise ValueError(f"Invalid integer field: {key}")

    try:
        i = int(float(value))
    except Exception:
        raise ValueError(f"Invalid integer field: {key}")

    if i < min_value:
        i = min_value
    elif i > max_value:
        i = max_value

    return i


def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    speed = _as_float(data, "speed", required=True)
    weight = _as_float(data, "weight", required=True)
    beam = _as_float(data, "beam", required=True)
    length = _as_float(data, "length", required=True)
    lcg = _as_float(data, "lcg", required=True)
    vcg = _as_float(data, "vcg", required=True)
    beta = _as_float(data, "beta", required=True)

    epsilon = _as_float(data, "epsilon", default=0.0)
    Lf = _as_float(data, "Lf", default=0.0)
    sigma = _as_float(data, "sigma", default=0.0)
    delta = _as_float(data, "delta", default=0.0)
    H_sig = _as_float(data, "H_sig", default=0.0)

    wetted_lengths_type = _as_int(
        data,
        "wetted_lengths_type",
        default=3,
        min_value=1,
        max_value=3,
    )

    roughness_penalty_type = _as_int(
        data,
        "roughness_penalty_type",
        default=2,
        min_value=0,
        max_value=3,
    )

    if speed <= 0.0:
        raise ValueError("speed must be positive.")

    if weight <= 0.0:
        raise ValueError("weight must be positive.")

    if beam <= 0.0:
        raise ValueError("beam must be positive.")

    if length <= 0.0:
        raise ValueError("length must be positive.")

    if lcg < 0.0 or lcg > length:
        raise ValueError("lcg must be between 0 and length.")

    if vcg < 0.0:
        raise ValueError("vcg must be non-negative.")

    if beta < 0.0 or beta > 45.0:
        raise ValueError("beta must be between 0 and 45 degrees.")

    if Lf < 0.0:
        raise ValueError("Lf must be non-negative.")

    if H_sig < 0.0:
        raise ValueError("H_sig must be non-negative.")

    return {
        "speed": speed,
        "weight": weight,
        "beam": beam,
        "length": length,
        "lcg": lcg,
        "vcg": vcg,
        "beta": beta,
        "epsilon": epsilon,
        "Lf": Lf,
        "sigma": sigma,
        "delta": delta,
        "H_sig": H_sig,
        "wetted_lengths_type": wetted_lengths_type,
        "roughness_penalty_type": roughness_penalty_type,
    }


@method_decorator(csrf_exempt, name="dispatch")
class SavitskySimulationView(View):
    """
    Optimized Savitsky planing hull endpoint.

    POST /savitsky/

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

        cache_key = hashlib.blake2b(
            b"savitsky-v1:" + raw_body,
            digest_size=16,
        ).hexdigest()

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
            solver = SavitskyModel(**parsed)
            result = solver.execute_solver()

            output_payload = {
                "success": True,
                "data": result,
                "message": "Savitsky planing hull calculation executed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)

            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Savitsky hydrodynamic simulation failed: {str(exc)}",
                status=500,
            )