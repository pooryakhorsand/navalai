# resistance/savitsky/engine.py
import math

try:
    from openplaning import PlaningBoat
    OPENPLANING_IMPORT_ERROR = None
except Exception as exc:
    PlaningBoat = None
    OPENPLANING_IMPORT_ERROR = exc


RHO_WATER = 1025.87
G = 9.80665


_FRICTION_ATTRS = (
    "R_f", "R_F", "rf", "r_f", "R_f_total",
    "friction_resistance", "skin_friction",
)

_PRESSURE_ATTRS = (
    "R_p", "R_P", "rp", "r_p", "R_w", "R_W",
    "pressure_resistance", "bare_hull_resistance",
)

_FLAP_ATTRS = (
    "R_flap", "R_Flap", "r_flap", "R_flaps",
    "flap_resistance",
)

_WETTED_AREA_ATTRS = (
    "wetted_bottom_area", "S_wet", "S", "Aw", "A_wet",
)

_ADDED_WAVE_ATTRS = (
    "R_AW", "R_aw", "raw", "R_AW_vertical",
    "added_resistance_waves",
)

_CG_ACCEL_ATTRS = (
    "n_cg", "n_CG", "ncg", "n_cg_vertical",
    "cg_acceleration",
)

_BOW_ACCEL_ATTRS = (
    "n_bow", "n_Bow", "nbow", "bow_acceleration",
)


def _to_float_or_none(value):
    try:
        f = float(value)
    except Exception:
        return None

    if not math.isfinite(f):
        return None

    return f


def _safe_float(value, default=0.0):
    f = _to_float_or_none(value)
    return default if f is None else f


def _first_attr_float(obj, names, positive_only=False):
    for name in names:
        try:
            value = getattr(obj, name)
        except Exception:
            continue

        f = _to_float_or_none(value)

        if f is None:
            continue

        if positive_only and f <= 0.0:
            continue

        return f

    return 0.0


def _results_dict(obj):
    try:
        results = getattr(obj, "results", None)
    except Exception:
        return {}

    return results if isinstance(results, dict) else {}


def _first_result_float(results, names, positive_only=False):
    if not isinstance(results, dict):
        return 0.0

    for name in names:
        if name not in results:
            continue

        f = _to_float_or_none(results.get(name))

        if f is None:
            continue

        if positive_only and f <= 0.0:
            continue

        return f

    return 0.0


class SavitskyModel:
    """
    Fast wrapper around openplaning.PlaningBoat for Savitsky planing hull prediction.
    """

    __slots__ = (
        "speed",
        "weight",
        "beam",
        "length",
        "lcg",
        "vcg",
        "beta",
        "epsilon",
        "vT",
        "lT",
        "r_g",
        "Lf",
        "sigma",
        "delta",
        "H_sig",
        "wetted_lengths_type",
        "roughness_penalty_type",
    )

    def __init__(
        self,
        speed,
        weight,
        beam,
        length,
        lcg,
        vcg,
        beta,
        epsilon=0.0,
        Lf=0.0,
        sigma=0.0,
        delta=0.0,
        H_sig=0.0,
        wetted_lengths_type=3,
        roughness_penalty_type=2,
    ):
        self.speed = float(speed)
        self.weight = float(weight)
        self.beam = float(beam)
        self.length = float(length)
        self.lcg = float(lcg)
        self.vcg = float(vcg)
        self.beta = float(beta)

        self.epsilon = float(epsilon)
        self.vT = float(vcg)
        self.lT = float(lcg)
        self.r_g = 0.25 * float(length)

        self.Lf = float(Lf)
        self.sigma = float(sigma)
        self.delta = float(delta)
        self.H_sig = float(H_sig)

        self.wetted_lengths_type = int(wetted_lengths_type)
        self.roughness_penalty_type = int(roughness_penalty_type)

    def execute_solver(self):
        if PlaningBoat is None:
            raise RuntimeError(
                f"openplaning package could not be imported: {OPENPLANING_IMPORT_ERROR}"
            )

        boat = PlaningBoat(
            speed=self.speed,
            weight=self.weight,
            beam=self.beam,
            lcg=self.lcg,
            vcg=self.vcg,
            r_g=self.r_g,
            beta=self.beta,
            epsilon=self.epsilon,
            vT=self.vT,
            lT=self.lT,
            loa=self.length,
            H_sig=self.H_sig,
            Lf=self.Lf,
            sigma=self.sigma,
            delta=self.delta,
            wetted_lengths_type=self.wetted_lengths_type,
            roughness_penalty_type=self.roughness_penalty_type,
        )

        boat.get_steady_trim()

        results = _results_dict(boat)

        # Frictional resistance
        r_f = _first_attr_float(boat, _FRICTION_ATTRS, positive_only=True)
        if r_f == 0.0:
            r_f = _first_result_float(results, _FRICTION_ATTRS, positive_only=True)

        # Pressure / bare-hull resistance
        r_p = _first_attr_float(boat, _PRESSURE_ATTRS, positive_only=True)
        if r_p == 0.0:
            r_p = _first_result_float(results, _PRESSURE_ATTRS, positive_only=True)

        # Flap resistance
        r_flap = _first_attr_float(boat, _FLAP_ATTRS, positive_only=True)
        if r_flap == 0.0:
            r_flap = _first_result_float(results, _FLAP_ATTRS, positive_only=True)

        # Trim angle
        tau_deg = _first_attr_float(
            boat,
            ("tau", "trim_tau", "trim"),
            positive_only=False,
        )
        tau_rad = math.radians(tau_deg)

        # Fallback pressure resistance
        if r_p == 0.0 and tau_rad > 0.0:
            r_p = self.weight * math.sin(tau_rad)

        # Fallback frictional resistance
        if r_f == 0.0:
            wetted_area = _first_attr_float(
                boat,
                _WETTED_AREA_ATTRS,
                positive_only=True,
            )
            if wetted_area > 0.0:
                cf = 0.002
                r_f = 0.5 * RHO_WATER * self.speed * self.speed * wetted_area * cf

        r_f = max(0.0, _safe_float(r_f))
        r_p = max(0.0, _safe_float(r_p))
        r_flap = max(0.0, _safe_float(r_flap))

        total_resistance = r_f + r_p + r_flap
        total_resistance = _safe_float(total_resistance)

        effective_power = _safe_float((total_resistance * self.speed) / 1000.0)
        effective_hp = _safe_float(effective_power * 1.34102)

        L_K = _first_attr_float(
            boat,
            ("L_K", "LK", "keel_wetted_length"),
            positive_only=False,
        )
        L_C = _first_attr_float(
            boat,
            ("L_C", "LC", "chine_wetted_length"),
            positive_only=False,
        )

        mean_lambda = 0.0
        if self.beam > 0.0:
            mean_lambda = (L_K + L_C) / (2.0 * self.beam)

        wetted_area = _first_attr_float(
            boat,
            _WETTED_AREA_ATTRS,
            positive_only=False,
        )

        draft_transom = _first_attr_float(
            boat,
            ("T", "draft_at_transom", "draft_transom", "transom_draft"),
            positive_only=False,
        )

        z_wl = _first_attr_float(
            boat,
            ("z_wl", "z_WL", "heave_z_wl"),
            positive_only=False,
        )

        fn_beam = 0.0
        if self.beam > 0.0:
            fn_beam = self.speed / math.sqrt(G * self.beam)

        volume_displacement = 0.0
        if self.weight > 0.0:
            volume_displacement = self.weight / (RHO_WATER * G)

        fn_volume = 0.0
        if volume_displacement > 0.0:
            fn_volume = self.speed / math.sqrt(
                G * (volume_displacement ** (1.0 / 3.0))
            )

        added_resistance_waves = _first_attr_float(
            boat,
            _ADDED_WAVE_ATTRS,
            positive_only=False,
        )
        if added_resistance_waves == 0.0:
            added_resistance_waves = _first_result_float(
                results,
                _ADDED_WAVE_ATTRS,
                positive_only=False,
            )

        cg_acceleration = _first_attr_float(
            boat,
            _CG_ACCEL_ATTRS,
            positive_only=False,
        )
        if cg_acceleration == 0.0:
            cg_acceleration = _first_result_float(
                results,
                _CG_ACCEL_ATTRS,
                positive_only=False,
            )

        bow_acceleration = _first_attr_float(
            boat,
            _BOW_ACCEL_ATTRS,
            positive_only=False,
        )
        if bow_acceleration == 0.0:
            bow_acceleration = _first_result_float(
                results,
                _BOW_ACCEL_ATTRS,
                positive_only=False,
            )

        # Fallback seaway accelerations
        if cg_acceleration == 0.0 and self.H_sig > 0.0:
            if tau_deg > 0.0 and self.beam > 0.0:
                cg_acceleration = (
                    0.084
                    * (self.H_sig / self.beam)
                    * (fn_beam ** 2.0)
                    * (tau_deg / 20.0)
                )
                bow_acceleration = cg_acceleration * 2.3

        return {
            "vessel_specs": {
                "fn_beam": _safe_float(fn_beam),
                "fn_volume": _safe_float(fn_volume),
                "volume_displacement": _safe_float(volume_displacement),
                "mass_kg": _safe_float(self.weight / G),
            },
            "equilibrium_attitude": {
                "trim_tau_deg": _safe_float(tau_deg),
                "heave_z_wl_m": _safe_float(z_wl),
            },
            "running_geometry": {
                "keel_wetted_length_lk": _safe_float(L_K),
                "chine_wetted_length_lc": _safe_float(L_C),
                "mean_wetted_length_ratio_lambda": _safe_float(mean_lambda),
                "draft_at_transom_m": _safe_float(draft_transom),
                "wetted_surface_area_m2": _safe_float(wetted_area),
            },
            "forces_breakdown": {
                "hydrodynamic_force_n": [
                    _safe_float(r_p),
                    _safe_float(self.weight),
                    0.0,
                ],
                "skin_friction_n": [
                    _safe_float(r_f),
                    0.0,
                    0.0,
                ],
                "flap_force_n": [
                    _safe_float(r_flap),
                    0.0,
                    0.0,
                ],
                "net_force_n": [
                    _safe_float(total_resistance),
                    0.0,
                    0.0,
                ],
            },
            "power_metrics": {
                "thrust_magnitude_n": _safe_float(total_resistance),
                "effective_power_kw": _safe_float(effective_power),
                "effective_horsepower": _safe_float(effective_hp),
            },
            "seaway_behavior": {
                "added_resistance_waves_n": _safe_float(added_resistance_waves),
                "cg_acceleration_g": _safe_float(cg_acceleration),
                "bow_acceleration_g": _safe_float(bow_acceleration),
            },
        }