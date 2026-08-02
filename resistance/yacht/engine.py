# resistance/yacht/engine.py

import os
import pickle
import numpy as np
from math import log, sqrt

try:
    from django.conf import settings
    _BASE_DIR = settings.BASE_DIR
except Exception:
    _BASE_DIR = None

# Singleton cache for the ML model
_RR_MODEL = None

# مسیر واقعی فایل مدل روی دیسک:
# <BASE_DIR>/resistance/static/resistance/model/yacht_catboost_model.pkl
_DEFAULT_MODEL_NAME = os.path.join(
    "resistance", "static", "resistance", "model", "yacht_catboost_model.pkl"
)


def _resolve_model_path():
    if _BASE_DIR is not None:
        return os.path.join(_BASE_DIR, _DEFAULT_MODEL_NAME)
    # fallback نسبت به مکان همین فایل (resistance/yacht/engine.py)
    # از resistance/yacht بریم بالا به resistance/ و از اونجا به static/resistance/model/...
    return os.path.join(
        os.path.dirname(__file__), "..", "static", "resistance", "model", "yacht_catboost_model.pkl"
    )


def _load_rr_model():
    global _RR_MODEL
    if _RR_MODEL is None:
        path = _resolve_model_path()
        if not os.path.exists(path):
            raise FileNotFoundError(f"Yacht resistance model not found at: {path}")
        with open(path, "rb") as f:
            _RR_MODEL = pickle.load(f)
    return _RR_MODEL


class YachtCalculation:
    """
    Placeholder for yacht parameter estimation from L, B, T.
    TODO: Replace method bodies with your real hydrodynamic formulas.
    """
    def __init__(self, L, B, T):
        self.L = float(L)
        self.B = float(B)
        self.T = float(T)
        # Dummy estimations — replace with your actual logic
        self.lcb = self.L * 0.025
        self.Pc = 0.55 + 0.01 * (self.B / self.T)
        self.displacement = self.L * self.B * self.T * 1.025

    def get_results(self):
        return {
            "L": self.L,
            "B": self.B,
            "T": self.T,
            "lcb": self.lcb,
            "Pc": self.Pc,
            "displacement": self.displacement,
        }


def yacht_calculate_resistances(L, B, T, lcb, Pc, displacement):
    """
    Calculate resistances over the standard 14 Froude numbers.
    Returns dict of 1-D float64 numpy arrays.
    """
    L = float(L)
    B = float(B)
    T = float(T)
    lcb = float(lcb)
    Pc = float(Pc)
    displacement = float(displacement)

    L_over_disp = L / (displacement ** (1.0 / 3.0))
    B_over_T = B / T
    L_over_B = L / B

    froude_numbers = np.array([
        0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.275, 0.3,
        0.325, 0.35, 0.375, 0.4, 0.425, 0.45
    ], dtype=np.float64)

    model = _load_rr_model()
    S = (1.97 + 0.171 * (B / T)) * sqrt(displacement * L)

    g = 9.81
    rho = 1025.0

    residuary_list = []
    for fn in froude_numbers:
        features = np.array([lcb, Pc, L_over_disp, B_over_T, L_over_B, fn], dtype=np.float64).reshape(1, -1)
        pred = model.predict(features)
        # Normalize scalar vs array output from different pickle types
        if hasattr(pred, "__len__") and not isinstance(pred, (str, bytes)):
            pred = pred[0]
        residuary_list.append(float(pred))

    Rr_arr = np.array(residuary_list, dtype=np.float64)
    v = froude_numbers * sqrt(L * g)
    Rn = v * L / 1e-6
    Cf = 0.075 / (np.log10(Rn) - 2.0) ** 2
    Rf_arr = 0.5 * rho * (v ** 2) * S * Cf
    Rt_arr = Rr_arr + Rf_arr

    return {
        "froude_series": froude_numbers,
        "residuary_series": Rr_arr,
        "friction_series": Rf_arr,
        "total_series": Rt_arr,
    }