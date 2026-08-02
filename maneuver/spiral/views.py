# maneuver/spiral/views.py
import base64
import gzip
import hashlib
import json
import math
import threading
from collections import OrderedDict

import numpy as np
from django.http import HttpResponse
from django.shortcuts import render
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from .engine import SpiralModel, _COEF_ORDER

try:
    import orjson
except Exception:
    orjson = None


MAX_BODY_BYTES = 128 * 1024
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


def _parse_x_initial(data):
    x_initial = data.get("x_initial", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])

    if not isinstance(x_initial, (list, tuple)) or len(x_initial) != 7:
        raise ValueError(
            "Initial state vector 'x_initial' must contain exactly 7 elements."
        )

    arr = np.asarray([float(v) for v in x_initial], dtype=np.float64)

    if not np.all(np.isfinite(arr)):
        raise ValueError("Initial state vector contains non-finite values.")

    return arr


def _parse_rudder_list(data):
    rudder_list = data.get("rudder_list_deg")
    if rudder_list is None:
        return None

    if not isinstance(rudder_list, (list, tuple)):
        raise ValueError("rudder_list_deg must be a list.")

    parsed = []
    for val in rudder_list:
        try:
            f = float(val)
        except Exception:
            raise ValueError("Invalid value in rudder_list_deg.")

        if not math.isfinite(f):
            raise ValueError("Non-finite value in rudder_list_deg.")

        parsed.append(f)

    if len(parsed) == 0:
        raise ValueError("rudder_list_deg cannot be empty.")

    return parsed


def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    params = {
        "U0": _as_float(data, "U0", required=True),
        "L": _as_float(data, "L", required=True),
        "m": _as_float(data, "m", required=True),
        "Iz": _as_float(data, "Iz", required=True),
        "xG": _as_float(data, "xG", required=True),
        "h": _as_float(data, "h", default=0.1),
        "T_delta": _as_float(data, "T_delta", default=1.0),
    }

    if params["h"] <= 0:
        raise ValueError("h must be positive.")

    if params["T_delta"] < 0:
        raise ValueError("T_delta must be non-negative.")

    for name in _COEF_ORDER:
        params[name] = _as_float(data, name, default=0.0)

    T = _as_float(data, "T", default=400.0)
    if T <= 0:
        raise ValueError("T must be positive.")
    if T > 7200:
        raise ValueError("T is too large. Maximum allowed T is 7200 s.")

    x_initial = _parse_x_initial(data)
    rudder_list_deg = _parse_rudder_list(data)

    steady_avg_steps = _as_int(
        data,
        "steady_avg_steps",
        default=200,
        min_value=1,
        max_value=10000
    )

    response_format = str(data.get("response_format", "json")).lower().strip()
    if response_format not in ("json", "compact"):
        response_format = "json"

    return {
        "params": params,
        "T": T,
        "x_initial": x_initial,
        "rudder_list_deg": rudder_list_deg,
        "steady_avg_steps": steady_avg_steps,
        "response_format": response_format,
    }


@method_decorator(csrf_exempt, name="dispatch")
class SpiralSimulationView(View):
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
            model = SpiralModel(
                **parsed["params"],
                x0=parsed["x_initial"],
            )

            results = model.simulate_spiral(
                T=parsed["T"],
                rudder_list_deg=parsed["rudder_list_deg"],
                steady_avg_steps=parsed["steady_avg_steps"]
            )

            output_payload = {
                "success": True,
                "data": {
                    "metrics": {
                        "rudder_deg": results["rudder_deg"],
                        "steady_yaw_deg_s": results["steady_yaw_deg_s"],
                    },
                    "time_series": {
                        "t_series": results["t_series"],
                    },
                    "detailed": {
                        "yaw_rate_dict": results["yaw_rate_dict"],
                        "heading_dict": results["heading_dict"],
                        "traj_dict": results["traj_dict"],
                        "u_dict": results["u_dict"],
                        "v_dict": results["v_dict"],
                        "U_dict": results["U_dict"],
                    }
                },
                "message": "Spiral maneuver simulation completed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)

            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Spiral simulation failed: {str(exc)}",
                status=500,
            )


class SpiralCombinedView(SpiralSimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "maneuver/spiral.html")