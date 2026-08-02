# maneuver/spiral/engine.py
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


_COEF_ORDER = [
    "Xudot", "Yvdot", "Nvdot", "Xu", "Yrdot", "Nrdot", "Xuu", "Yv", "Nv",
    "Xuuu", "Yr", "Nr", "Xvv", "Yvvv", "Nvvv", "Xrr", "Yvvr", "Nvvr",
    "Xdd", "Yvu", "Nvu", "Xudd", "Yru", "Nru", "Xrv", "Yd", "Nd", "Xvd",
    "Yddd", "Nddd", "Xuvd", "Yud", "Nud", "Yuud", "Nuud", "Yvdd", "Nvdd",
    "Yvvd", "Nvvd", "Y0", "N0", "Y0u", "N0u", "Y0uu", "N0uu",
]


@njit(cache=True, fastmath=True)
def _simulate_spiral_step_core(
    x,
    ui,
    h,
    U0,
    L,
    m,
    Iz,
    xG,
    T_delta,
    coef
):
    (
        Xudot, Yvdot, Nvdot, Xu, Yrdot, Nrdot, Xuu, Yv, Nv,
        Xuuu, Yr, Nr, Xvv, Yvvv, Nvvv, Xrr, Yvvr, Nvvr,
        Xdd, Yvu, Nvu, Xudd, Yru, Nru, Xrv, Yd, Nd, Xvd,
        Yddd, Nddd, Xuvd, Yud, Nud, Yuud, Nuud, Yvdd, Nvdd,
        Yvvd, Nvvd, Y0, N0, Y0u, N0u, Y0uu, N0uu
    ) = coef

    m11 = m - Xudot
    m22 = m - Yvdot
    m23 = m * xG - Yrdot
    m32 = m * xG - Nvdot
    m33 = Iz - Nrdot
    detM22 = m22 * m33 - m23 * m32

    U = np.sqrt((U0 + x[0]) * (U0 + x[0]) + x[1] * x[1])
    if U < 1e-12:
        U = 1e-12

    u_nd = x[0] / U
    v_nd = x[1] / U
    r = x[2]
    psi = x[5]
    delta = x[6]

    inv_l = 1.0 / L
    inv_l2 = inv_l * inv_l
    r_nd = r * L / U

    u2 = u_nd * u_nd
    u3 = u2 * u_nd
    v2 = v_nd * v_nd
    v3 = v2 * v_nd
    r2_nd = r_nd * r_nd
    d2 = delta * delta
    d3 = d2 * delta

    X_force = (
        Xu * u_nd
        + Xuu * u2
        + Xuuu * u3
        + Xvv * v2
        + Xrr * r2_nd
        + Xrv * r_nd * v_nd
        + Xdd * d2
        + Xudd * u_nd * d2
        + Xvd * v_nd * delta
        + Xuvd * u_nd * v_nd * delta
    )

    Y_force = (
        Yv * v_nd
        + Yr * r_nd
        + Yvvv * v3
        + Yvvr * v2 * r_nd
        + Yvu * v_nd * u_nd
        + Yru * r_nd * u_nd
        + Yd * delta
        + Yddd * d3
        + Yud * u_nd * delta
        + Yuud * u2 * delta
        + Yvdd * v_nd * d2
        + Yvvd * v2 * delta
        + (Y0 + Y0u * u_nd + Y0uu * u2)
    )

    N_force = (
        Nv * v_nd
        + Nr * r_nd
        + Nvvv * v3
        + Nvvr * v2 * r_nd
        + Nvu * v_nd * u_nd
        + Nru * r_nd * u_nd
        + Nd * delta
        + Nddd * d3
        + Nud * u_nd * delta
        + Nuud * u2 * delta
        + Nvdd * v_nd * d2
        + Nvvd * v2 * delta
        + (N0 + N0u * u_nd + N0uu * u2)
    )

    U2 = U * U

    xdot0 = X_force * (U2 * inv_l) / m11
    xdot1 = (m33 * Y_force - m23 * N_force) * (U2 * inv_l) / detM22
    xdot2 = (-m32 * Y_force + m22 * N_force) * (U2 * inv_l2) / detM22

    cpsi = np.cos(psi)
    spsi = np.sin(psi)

    xdot3 = (cpsi * (U0 / U + u_nd) - spsi * v_nd) * U
    xdot4 = (spsi * (U0 / U + u_nd) + cpsi * v_nd) * U
    xdot5 = r
    xdot6 = 0.0
    if T_delta > 1e-18:
        xdot6 = (ui - delta) / T_delta
    else:
        xdot6 = 0.0

    x_new = x.copy()
    x_new[0] += h * xdot0
    x_new[1] += h * xdot1
    x_new[2] += h * xdot2
    x_new[3] += h * xdot3
    x_new[4] += h * xdot4
    x_new[5] += h * xdot5
    x_new[6] += h * xdot6

    return x_new, U


class SpiralModel:
    def __init__(
        self,
        U0,
        L,
        m,
        Iz,
        xG,
        Xudot,
        Yvdot,
        Nvdot,
        Xu,
        Yrdot,
        Nrdot,
        Xuu,
        Yv,
        Nv,
        Xuuu,
        Yr,
        Nr,
        Xvv,
        Yvvv,
        Nvvv,
        Xrr,
        Yvvr,
        Nvvr,
        Xdd,
        Yvu,
        Nvu,
        Xudd,
        Yru,
        Nru,
        Xrv,
        Yd,
        Nd,
        Xvd,
        Yddd,
        Nddd,
        Xuvd,
        Yud,
        Nud,
        Yuud,
        Nuud,
        Yvdd,
        Nvdd,
        Yvvd,
        Nvvd,
        Y0,
        N0,
        Y0u,
        N0u,
        Y0uu,
        N0uu,
        x0=None,
        h=0.1,
        T_delta=1.0
    ):
        if x0 is None:
            x0 = np.zeros(7, dtype=np.float64)

        self.x_initial = np.asarray(x0, dtype=np.float64).copy()
        self.U0 = float(U0)
        self.L = float(L)
        self.h = float(h)
        self.m = float(m)
        self.Iz = float(Iz)
        self.xG = float(xG)
        self.T_delta = float(T_delta)

        local_vars = locals()
        self.coef = np.array(
            [float(local_vars[name]) for name in _COEF_ORDER],
            dtype=np.float64
        )

    def simulate_spiral(self, T=400.0, rudder_list_deg=None, steady_avg_steps=200):
        if rudder_list_deg is None:
            rudder_list_deg = [-20, -15, -10, -5, 0, 5, 10, 15, 20]

        rudder_list_deg = list(rudder_list_deg)
        rudder_angles_rad = np.array(
            [np.radians(d) for d in rudder_list_deg],
            dtype=np.float64
        )

        N = int(round(float(T) / self.h))
        if N < 1:
            N = 1

        steady_avg_steps = int(steady_avg_steps)
        if steady_avg_steps < 1:
            steady_avg_steps = 1
        if steady_avg_steps > N:
            steady_avg_steps = N

        steady_yaw_rates_deg_s = []
        yaw_rate_dict = {}
        heading_dict = {}
        traj_dict = {}
        u_dict = {}
        v_dict = {}
        U_dict = {}

        t_series = np.arange(0, N + 1) * self.h

        for delta_cmd, delta_deg in zip(rudder_angles_rad, rudder_list_deg):
            x = self.x_initial.copy()

            yaw_rate_hist = np.empty(N + 1, dtype=np.float64)
            heading_hist = np.empty(N + 1, dtype=np.float64)
            x_path_hist = np.empty(N + 1, dtype=np.float64)
            y_path_hist = np.empty(N + 1, dtype=np.float64)
            u_hist = np.empty(N + 1, dtype=np.float64)
            v_hist = np.empty(N + 1, dtype=np.float64)
            U_hist = np.empty(N + 1, dtype=np.float64)

            for i in range(N + 1):
                x_new, U_cur = _simulate_spiral_step_core(
                    x,
                    delta_cmd,
                    self.h,
                    self.U0,
                    self.L,
                    self.m,
                    self.Iz,
                    self.xG,
                    self.T_delta,
                    self.coef
                )

                yaw_rate_hist[i] = np.degrees(x_new[2])
                heading_hist[i] = np.degrees(x_new[5])
                x_path_hist[i] = x_new[3]
                y_path_hist[i] = x_new[4]
                u_hist[i] = x_new[0]
                v_hist[i] = x_new[1]
                U_hist[i] = U_cur

                x = x_new

            steady_slice = yaw_rate_hist[-steady_avg_steps:]
            steady_yaw = float(np.mean(steady_slice))
            steady_yaw_rates_deg_s.append(steady_yaw)

            deg_key = float(delta_deg)
            yaw_rate_dict[deg_key] = yaw_rate_hist.tolist()
            heading_dict[deg_key] = heading_hist.tolist()
            traj_dict[deg_key] = {
                "x": x_path_hist.tolist(),
                "y": y_path_hist.tolist()
            }
            u_dict[deg_key] = u_hist.tolist()
            v_dict[deg_key] = v_hist.tolist()
            U_dict[deg_key] = U_hist.tolist()

        return {
            "rudder_deg": rudder_list_deg,
            "steady_yaw_deg_s": steady_yaw_rates_deg_s,
            "t_series": t_series.tolist(),
            "yaw_rate_dict": yaw_rate_dict,
            "heading_dict": heading_dict,
            "traj_dict": traj_dict,
            "u_dict": u_dict,
            "v_dict": v_dict,
            "U_dict": U_dict
        }


def warmup_numba():
    if not NUMBA_AVAILABLE:
        return

    x0 = np.zeros(7, dtype=np.float64)
    coef = np.zeros(len(_COEF_ORDER), dtype=np.float64)

    _simulate_spiral_step_core(
        x0,
        0.0,
        0.1,
        7.0,
        160.0,
        0.00798,
        0.000392,
        -0.023,
        1.0,
        coef
    )