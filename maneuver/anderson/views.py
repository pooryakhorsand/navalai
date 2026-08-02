# maneuver/anderson/views.py
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

from .engine import AndersonTurnModel, _COEF_ORDER, warmup_numba
from .serializers import AndersonInputSerializer

try:
    import orjson
except Exception:
    orjson = None

MAX_BODY_BYTES = 128 * 1024
MAX_STEPS = 50_000
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

def _parse_x_initial(data):
    x_initial = data.get("x_initial", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    if not isinstance(x_initial, (list, tuple)) or len(x_initial) != 7:
        raise ValueError("Initial state vector 'x_initial' must contain exactly 7 elements.")
    arr = np.asarray([float(v) for v in x_initial], dtype=np.float64)
    if not np.all(np.isfinite(arr)):
        raise ValueError("Initial state vector contains non-finite values.")
    return arr

def _parse_payload(data):
    if not isinstance(data, dict):
        raise ValueError("JSON body must be an object.")

    U0 = _as_float(data, "U0", required=True)
    L = _as_float(data, "L", required=True)
    m = _as_float(data, "m", required=True)
    Iz = _as_float(data, "Iz", required=True)
    xG = _as_float(data, "xG", required=True)

    Tmax = _as_float(data, "Tmax", default=1200.0)
    h = _as_float(data, "h", default=0.1)
    psi_target_deg = _as_float(data, "psi_target_deg", default=100.0)
    delta_hard_deg = _as_float(data, "delta_hard_deg", default=35.0)
    max_rudder_rate_deg = _as_float(data, "max_rudder_rate_deg", default=5.0)

    if Tmax <= 0:
        raise ValueError("Tmax must be positive.")
    if h <= 0:
        raise ValueError("h must be positive.")
    if Tmax > 7200:
        raise ValueError("Tmax is too large. Maximum allowed is 7200 s.")
    if abs(psi_target_deg) > 360:
        raise ValueError("psi_target_deg must be between -360 and 360 degrees.")
    if abs(delta_hard_deg) > 90:
        raise ValueError("delta_hard_deg must be between -90 and 90 degrees.")
    if max_rudder_rate_deg <= 0 or max_rudder_rate_deg > 30:
        raise ValueError("max_rudder_rate_deg must be between 0 and 30 degrees.")

    steps = int(round(Tmax / h))
    if steps < 1:
        raise ValueError("Simulation step count is invalid.")
    if steps > MAX_STEPS:
        raise ValueError(
            f"Too many integration steps: {steps}. "
            f"Increase h or reduce Tmax. Maximum allowed steps: {MAX_STEPS}."
        )

    x_initial = _parse_x_initial(data)

    params = {
        "U0": U0,
        "L": L,
        "m": m,
        "Iz": Iz,
        "xG": xG,
        "h": h,
        "Tmax": Tmax,
        "psi_target_deg": psi_target_deg,
        "delta_hard_deg": delta_hard_deg,
        "max_rudder_rate_deg": max_rudder_rate_deg,
    }

    for name in _COEF_ORDER:
        params[name] = _as_float(data, name, default=0.0)

    m11 = params["m"] - params["Xudot"]
    m22 = params["m"] - params["Yvdot"]
    m23 = params["m"] * params["xG"] - params["Yrdot"]
    m32 = params["m"] * params["xG"] - params["Nvdot"]
    m33 = params["Iz"] - params["Nrdot"]
    det_m22 = m22 * m33 - m23 * m32

    if abs(m11) < 1e-14:
        raise ValueError("Invalid mass matrix: m - Xudot is too close to zero.")
    if abs(det_m22) < 1e-14:
        raise ValueError("Invalid sway-yaw mass matrix determinant.")

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
        "params": params,
        "x_initial": x_initial,
        "response_format": response_format,
        "output_stride": output_stride,
        "steps": steps,
    }

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

def _build_time_series_payload(
    response_format,
    output_stride,
    t_series,
    psi_deg,
    r_deg_s,
    rudder_cmd_deg,
    delta_actual_deg,
    x_series,
    y_series,
):
    n = int(t_series.shape[0])
    if n > 0 and math.ceil(n / output_stride) > MAX_RETURN_POINTS:
        output_stride = int(math.ceil(n / MAX_RETURN_POINTS))

    idx = _select_indices(n, output_stride)
    returned_n = int(idx.shape[0])

    if response_format == "compact":
        # ساختار فشرده باینری کاملاً منطبق با ساختار دیکودر app_anderson.js
        time_series_part = {
            "_format": "f32-base64-v1",
            "_length": returned_n,
            "t": _encode_f32_base64(t_series[idx]),
            "psi_deg": _encode_f32_base64(psi_deg[idx]),
            "r_deg_s": _encode_f32_base64(r_deg_s[idx]),
        }
        trajectory_part = {
            "x": _encode_f32_base64(x_series[idx]),
            "y": _encode_f32_base64(y_series[idx]),
        }
        rudder_part = {
            "rudder_cmd_deg": _encode_f32_base64(rudder_cmd_deg[idx]),
            "delta_actual_deg": _encode_f32_base64(delta_actual_deg[idx]),
        }
    else:
        # ساختار جیسون استاندارد با کلیدهای بازنویسی شده بر اساس نیاز فرانت
        time_series_part = {
            "t": np.round(t_series[idx], 6).tolist(),
            "psi_deg": np.round(psi_deg[idx], 6).tolist(),
            "r_deg_s": np.round(r_deg_s[idx], 6).tolist(),
        }
        trajectory_part = {
            "x": np.round(x_series[idx], 6).tolist(),
            "y": np.round(y_series[idx], 6).tolist(),
        }
        rudder_part = {
            "rudder_cmd_deg": np.round(rudder_cmd_deg[idx], 6).tolist(),
            "delta_actual_deg": np.round(delta_actual_deg[idx], 6).tolist(),
        }

    meta = {
        "sample_count_solver": n,
        "sample_count_returned": returned_n,
        "output_stride": int(output_stride),
        "max_return_points": MAX_RETURN_POINTS,
    }
    return time_series_part, trajectory_part, rudder_part, meta

class AndersonCombinedView(View):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        from django.shortcuts import render
        return render(request, "maneuver/anderson.html")

    def options(self, request, *args, **kwargs):
        resp = HttpResponse(status=204)
        resp["Allow"] = "GET, POST, OPTIONS"
        return resp

@method_decorator(csrf_exempt, name="dispatch")
class AndersonSimulationView(View):
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
            model = AndersonTurnModel(
                **parsed["params"],
                x0=parsed["x_initial"],
            )
            results = model.simulate()

            time_series_part, trajectory_part, rudder_part, series_meta = _build_time_series_payload(
                parsed["response_format"],
                parsed["output_stride"],
                results["t_series"],
                results["psi_deg"],
                results["r_deg_s"],
                results["rudder_cmd_deg"],
                results["delta_actual_deg"],
                results["x_series"],
                results["y_series"],
            )

            output_payload = {
                "success": True,
                "data": {
                    "metrics": {
                        "t_end": _safe_float(results["t_end"]),
                        "cross_track_error_m": _safe_float(results["cross_track_error_m"]),
                        "heading_error_deg": _safe_float(results["heading_error_deg"]),
                    },
                    "time_series": time_series_part,
                    "trajectory": trajectory_part,
                    "rudder": rudder_part,
                    "series_meta": series_meta,
                },
                "message": "Anderson Turn simulation completed successfully.",
            }

            raw_response = _json_dumps(output_payload)
            entry = _cache_set_raw(cache_key, raw_response)
            return _response_from_entry(entry, request, status=200)

        except Exception as exc:
            return _json_error(
                message=f"Simulation processing fault: {str(exc)}",
                status=500,
            )