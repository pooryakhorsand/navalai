# maneuver/holtrop/engine.py
import numpy as np

try:
    from numba import njit
    NUMBA_AVAILABLE = True
except Exception:
    NUMBA_AVAILABLE = False

    def njit(*dargs, **dkwargs):
        if dargs and callable(dargs[0]) and len(dargs) == 1 and not dkwargs:
            return dargs[0]

        def wrapper(func):
            return func

        return wrapper


_APPENDAGE_ORDER = [
    "behind_skeg", "behind_stern", "twin", "bracket", "skeg",
    "strut", "hull", "shaft", "fin", "dome", "keel",
]

_HULL_REQUIRED = [
    "wl", "beam", "df", "da", "lcb", "cb", "cm", "cwl",
]


@njit(cache=True, fastmath=True)
def _holtrop_core(
    wl, beam, df, da, lcb, cb, cm, cwl,
    bulbous, transom, aft_body,
    app_coefs, app_areas, N
):
    g = 9.81
    rho = 1025.0
    mi = 0.00122

    total_area = 0.0
    mult = 0.0
    for i in range(app_coefs.shape[0]):
        total_area += app_areas[i]
        mult += app_coefs[i] * app_areas[i]

    k2 = mult / total_area if total_area != 0.0 else 0.0
    t = (da + df) * 0.5
    sapp = total_area
    volume = wl * beam * t * cb
    cp = cb / cm

    lr = wl * (1.0 - cp + (0.06 * cp * (lcb / 100.0) / (4.0 * cp - 1.0)))
    hb = df * 0.5
    at = 0.95 * (da - da * 0.9225) * beam * 0.89 * transom
    abt = np.pi * (df * 0.5) * (df * 0.5) * bulbous / 7.7

    bw = beam / wl
    if bw < 0.11:
        c7 = 0.229577 * bw ** 0.33333
    elif bw < 0.25:
        c7 = bw
    else:
        c7 = 0.5 - 0.0625 * (wl / beam)

    ie = 1.0 + 89.0 * np.exp(
        -((wl / beam) ** 0.80856)
        * ((1.0 - cwl) ** 0.30484)
        * ((1.0 - cp - 0.0225 * (lcb / 100.0)) ** 0.6367)
        * ((lr / beam) ** 0.34574)
        * ((100.0 * (volume / (wl * wl * wl))) ** 0.16302)
    )

    c1 = 2223105.0 * (c7 ** 3.78613) * ((t / beam) ** 1.07961) * ((90.0 - ie) ** -1.37565)

    denom_c3 = beam * t * (0.31 * abt ** 0.5 + df - hb)
    c3 = 0.56 * (abt ** 1.5) / denom_c3 if denom_c3 != 0.0 else 0.0
    c2 = np.exp(-1.89 * c3 ** 0.5)
    c4 = 0.04 if (df / wl > 0.04) else (df / wl)
    c5 = 1.0 - (0.8 * at) / (beam * t * cm)

    if aft_body == 0:
        c14 = 1.0 + 0.011 * (-25.0)
    elif aft_body == 1:
        c14 = 1.0 + 0.011 * (-10.0)
    elif aft_body == 2:
        c14 = 1.0
    else:
        c14 = 1.0 + 0.011 * 10.0

    if (wl * wl * wl) / volume < 1726.91:
        c15 = -1.69385 + (wl / (volume ** (1.0 / 3.0)) - 8.0) / 2.36
    else:
        c15 = 0.0

    if cp < 0.8:
        c16 = 8.07981 * cp - 13.8673 * cp * cp + 6.984388 * cp * cp * cp
    else:
        c16 = 1.73014 - 0.7067 * cp

    c17 = 6919.3 * (cm ** -1.3346) * ((volume / (wl * wl * wl)) ** 2.00977) * ((wl / beam - 2.0) ** 1.40692)
    ca = (
        0.006 * ((wl + 100.0) ** -0.16) - 0.00205
        + 0.003 * ((wl / 7.5) ** 0.5) * (cb ** 4) * c2 * (0.04 - c4)
    )
    wa = wl * (2.0 * t + beam) * (cm ** 0.5) * (
        0.453 + 0.4425 * cb - 0.2862 * cm - 0.003467 * (beam / t) + 0.3696 * cwl
    ) + (2.38 * abt) / cb

    m1 = 0.0140407 * (wl / t) - 1.75254 * ((volume ** (1.0 / 3.0)) / wl) - 4.79323 * (beam / wl) - c16
    m3 = -7.2035 * ((beam / wl) ** 0.326869) * ((t / beam) ** 0.605375)
    lambd = (1.446 * cp - 0.36) if (wl / beam > 12.0) else (1.446 * cp - 0.03 * (wl / beam))

    denom_pb = df - 1.5 * hb
    pb = (0.56 * (abt ** 0.5)) / denom_pb if denom_pb != 0.0 else 0.0

    m4_04 = c15 * 0.4 * np.exp(-0.034 * (0.4 ** -3.29))
    m4_055 = c15 * 0.4 * np.exp(-0.034 * (0.55 ** -3.29))

    rwa_04 = c1 * c2 * c5 * volume * rho * g * np.exp(
        m1 * (0.4 ** -0.9) + m4_04 * np.cos(lambd * (0.4 ** -2))
    )
    rwa_055 = c17 * c2 * c5 * volume * rho * g * np.exp(
        m3 * (0.55 ** -0.9) + m4_055 * np.cos(lambd * (0.55 ** -2))
    )

    k = 0.93 + 0.487118 * c14 * ((beam / wl) ** 1.06806) * ((t / wl) ** 0.46106) * \
        ((wl / lr) ** 0.121563) * (((wl * wl * wl) / volume) ** 0.36486) * ((1.0 - cp) ** -0.604247)

    speeds = np.empty(N, dtype=np.float64)
    fn_arr = np.empty(N, dtype=np.float64)
    rf = np.empty(N, dtype=np.float64)
    r_app = np.empty(N, dtype=np.float64)
    rw = np.empty(N, dtype=np.float64)
    rb = np.empty(N, dtype=np.float64)
    rtr = np.empty(N, dtype=np.float64)
    r_total = np.empty(N, dtype=np.float64)

    for i in range(N):
        v = 0.514444 * i
        speeds[i] = v
        fn_i = v / (g * wl) ** 0.5
        fn_arr[i] = fn_i
        re_i = rho * wl * v / mi

        if v > 0.0:
            cf_i = 0.075 / (np.log10(re_i) - 2.0) ** 2
        else:
            cf_i = 0.0

        rf[i] = 0.5 * rho * v * v * wa * cf_i

        if at == 0.0:
            fnt_i = 0.0
        else:
            fnt_i = v / ((2.0 * g * at) / (beam + beam * cwl)) ** 0.5

        c6_i = 0.2 * (1.0 - 0.2 * fnt_i) if fnt_i < 5.0 else 0.0
        rtr[i] = 0.5 * rho * v * v * at * c6_i
        r_app[i] = 0.5 * rho * v * v * sapp * k2 * cf_i

        if fn_i == 0.0:
            rwa_i = 0.0
            rwb_i = 0.0
            r_wab_i = 0.0
        else:
            m4_i = c15 * 0.4 * np.exp(-0.034 * fn_i ** -3.29)
            rwa_i = c1 * c2 * c5 * volume * rho * g * np.exp(
                m1 * fn_i ** -0.9 + m4_i * np.cos(lambd * fn_i ** -2)
            )
            rwb_i = c17 * c2 * c5 * volume * rho * g * np.exp(
                m3 * fn_i ** -0.9 + m4_i * np.cos(lambd * fn_i ** -2)
            )
            r_wab_i = rwa_04 + (10.0 * fn_i - 4.0) * (rwa_055 - rwa_04) / 1.5

        if v > 0.0:
            fni_i = v / np.sqrt(g * (df - hb - 0.25 * abt ** 0.5) + (0.15 * v * v))
        else:
            fni_i = 0.0

        if fn_i < 0.4:
            rw[i] = rwa_i
        elif fn_i < 0.55:
            rw[i] = r_wab_i
        else:
            rw[i] = rwb_i

        if abt == 0.0:
            rb[i] = 0.0
        else:
            rb[i] = (0.11 * np.exp(-3.0 * pb ** -2) * fni_i ** 3 * abt ** 1.5 * rho * g) / (1.0 + fni_i ** 2)

        ra_i = 0.91 * 0.5 * rho * v * v * wa * ca
        r_total[i] = (k * rf[i] + r_app[i] + rw[i] + rb[i] + rtr[i] + ra_i) / 1000.0

    return speeds, fn_arr, rf, rw, r_app, rb, rtr, r_total


class HoltropModel:
    def __init__(
        self,
        wl, beam, df, da, lcb, cb, cm, cwl,
        bulbous=0.0, transom=0.0, aft_body=2,
        app_coefs=None, app_areas=None,
    ):
        self.wl = float(wl)
        self.beam = float(beam)
        self.df = float(df)
        self.da = float(da)
        self.lcb = float(lcb)
        self.cb = float(cb)
        self.cm = float(cm)
        self.cwl = float(cwl)
        self.bulbous = float(bulbous)
        self.transom = float(transom)
        self.aft_body = int(aft_body)

        n_app = len(_APPENDAGE_ORDER)
        self.app_coefs = (
            np.asarray(app_coefs, dtype=np.float64)
            if app_coefs is not None else np.zeros(n_app, dtype=np.float64)
        )
        self.app_areas = (
            np.asarray(app_areas, dtype=np.float64)
            if app_areas is not None else np.zeros(n_app, dtype=np.float64)
        )

    def calculate(self, N=41):
        return _holtrop_core(
            self.wl, self.beam, self.df, self.da, self.lcb,
            self.cb, self.cm, self.cwl, self.bulbous, self.transom,
            self.aft_body, self.app_coefs, self.app_areas, int(N),
        )


def warmup_numba():
    """
    Optional warm-up during Django startup to eliminate first-request JIT latency.
    """
    if not NUMBA_AVAILABLE:
        return

    coefs = np.zeros(len(_APPENDAGE_ORDER), dtype=np.float64)
    areas = np.zeros(len(_APPENDAGE_ORDER), dtype=np.float64)
    _holtrop_core(
        100.0, 15.0, 5.0, 5.0, 0.0,
        0.6, 0.98, 0.7,
        0.0, 0.0, 2,
        coefs, areas, 41,
    )