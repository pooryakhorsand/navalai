import numpy as np

# Kept for compatibility with views.py, which imports this list to
# build the `coef` dict / validate incoming fields.
_COEF_ORDER = [
    "Xudot", "Yvdot", "Nvdot", "Xu", "Yrdot", "Nrdot", "Xuu", "Yv", "Nv",
    "Xuuu", "Yr", "Nr", "Xvv", "Yvvv", "Nvvv", "Xrr", "Yvvr", "Nvvr",
    "Xdd", "Yvu", "Nvu", "Xudd", "Yru", "Nru", "Xrv", "Yd", "Nd", "Xvd",
    "Yddd", "Nddd", "Xuvd", "Yud", "Nud", "Yuud", "Nuud", "Yvdd", "Nvdd",
    "Yvvd", "Nvvd", "Y0", "N0", "Y0u", "N0u", "Y0uu", "N0uu",
]


class ShipStoppingModel:
    """
    Ship Stopping (Crash Stop / Astern) maneuver model.

    Plain numpy/Python port of the original, validated stopping.py
    model -- no numba, no reinterpretation of the nondimensionalization.
    u/v/r are built strictly from the perturbation state
    (x[0], x[1], x[2]), exactly like the original.
    """

    def __init__(
        self,
        U0=7.7175,
        L=160.93,
        m=798e-5,
        Iz=39.2e-5,
        xG=-0.023,
        Xudot=-42e-5,
        Yvdot=-748e-5,
        Nvdot=4.646e-5,
        Xu=-184e-5,
        Yrdot=-9.354e-5,
        Nrdot=-43.8e-5,
        Xuu=-110e-5,
        Yv=-1160e-5,
        Nv=-264e-5,
        Xuuu=-215e-5,
        Yr=-499e-5,
        Nr=-166e-5,
        Xvv=-899e-5,
        Yvvv=-8078e-5,
        Nvvv=1636e-5,
        Xrr=18e-5,
        Yvvr=15356e-5,
        Nvvr=-5483e-5,
        Xdd=-95e-5,
        Yvu=-1160e-5,
        Nvu=-264e-5,
        Xudd=-190e-5,
        Yru=-499e-5,
        Nru=-166e-5,
        Xrv=798e-5,
        Yd=278e-5,
        Nd=-139e-5,
        Xvd=93e-5,
        Yddd=-90e-5,
        Nddd=45e-5,
        Xuvd=93e-5,
        Yud=556e-5,
        Nud=-278e-5,
        Yuud=278e-5,
        Nuud=-139e-5,
        Yvdd=-4e-5,
        Nvdd=13e-5,
        Yvvd=1190e-5,
        Nvvd=-489e-5,
        Y0=-4e-5,
        N0=3e-5,
        Y0u=-8e-5,
        N0u=6e-5,
        Y0uu=-4e-5,
        N0uu=3e-5,
        h=0.1,
        thrust_reduction_time=20.0,
        reverse_thrust=-0.4,
        x0=None,
    ):
        self.U0 = float(U0)
        self.L = float(L)
        self.h = float(h)
        self.thrust_reduction_time = float(thrust_reduction_time)
        self.reverse_thrust = float(reverse_thrust)

        self.m = float(m)
        self.Iz = float(Iz)
        self.xG = float(xG)

        self.Xudot = Xudot
        self.Yvdot = Yvdot
        self.Nvdot = Nvdot
        self.Xu = Xu
        self.Yrdot = Yrdot
        self.Nrdot = Nrdot
        self.Xuu = Xuu
        self.Yv = Yv
        self.Nv = Nv
        self.Xuuu = Xuuu
        self.Yr = Yr
        self.Nr = Nr
        self.Xvv = Xvv
        self.Yvvv = Yvvv
        self.Nvvv = Nvvv
        self.Xrr = Xrr
        self.Yvvr = Yvvr
        self.Nvvr = Nvvr
        self.Xdd = Xdd
        self.Yvu = Yvu
        self.Nvu = Nvu
        self.Xudd = Xudd
        self.Yru = Yru
        self.Nru = Nru
        self.Xrv = Xrv
        self.Yd = Yd
        self.Nd = Nd
        self.Xvd = Xvd
        self.Yddd = Yddd
        self.Nddd = Nddd
        self.Xuvd = Xuvd
        self.Yud = Yud
        self.Nud = Nud
        self.Yuud = Yuud
        self.Nuud = Nuud
        self.Yvdd = Yvdd
        self.Nvdd = Nvdd
        self.Yvvd = Yvvd
        self.Nvvd = Nvvd
        self.Y0 = Y0
        self.N0 = N0
        self.Y0u = Y0u
        self.N0u = N0u
        self.Y0uu = Y0uu
        self.N0uu = N0uu

        if x0 is None:
            x0 = np.zeros(7, dtype=np.float64)
        self.x_initial = np.asarray(x0, dtype=np.float64).copy()

    def thrust_factor_at(self, t):
        """Linear reduction to zero then constant reverse thrust."""
        if t < self.thrust_reduction_time:
            return 1.0 - (t / self.thrust_reduction_time)
        else:
            return self.reverse_thrust

    def model(self, x, thrust_factor):
        # U must reflect the ship's actual accumulated speed, not be
        # rescaled by the (discontinuous) thrust_factor step function.
        # thrust_factor only belongs in the propulsion force (X_prop).
        U = np.sqrt((self.U0 + x[0]) ** 2 + x[1] ** 2)
        if U < 1e-12:
            U = 1e-12

        u = x[0] / U
        v = x[1] / U
        r = x[2] * self.L / U
        psi = x[5]
        delta = x[6]  # rudder fixed at 0

        # Mass matrix terms
        m11 = self.m - self.Xudot
        m22 = self.m - self.Yvdot
        m23 = self.m * self.xG - self.Yrdot
        m32 = self.m * self.xG - self.Nvdot
        m33 = self.Iz - self.Nrdot
        detM22 = m22 * m33 - m23 * m32

        # Propulsion force (scaled by thrust factor)
        X_prop = thrust_factor * 0.5 * self.U0 ** 2 * 1.0e-4

        # Hydrodynamic forces
        X = (self.Xu * u + self.Xuu * u**2 + self.Xuuu * u**3 +
             self.Xvv * v**2 + self.Xrr * r**2 + self.Xrv * r * v +
             self.Xdd * delta**2 + self.Xudd * u * delta**2 +
             self.Xvd * v * delta + self.Xuvd * u * v * delta) + X_prop

        Y = (self.Yv * v + self.Yr * r + self.Yvvv * v**3 + self.Yvvr * v**2 * r +
             self.Yvu * v * u + self.Yru * r * u + self.Yd * delta +
             self.Yddd * delta**3 + self.Yud * u * delta +
             self.Yuud * u**2 * delta + self.Yvdd * v * delta**2 +
             self.Yvvd * v**2 * delta +
             (self.Y0 + self.Y0u * u + self.Y0uu * u**2))

        N = (self.Nv * v + self.Nr * r + self.Nvvv * v**3 + self.Nvvr * v**2 * r +
             self.Nvu * v * u + self.Nru * r * u + self.Nd * delta +
             self.Nddd * delta**3 + self.Nud * u * delta +
             self.Nuud * u**2 * delta + self.Nvdd * v * delta**2 +
             self.Nvvd * v**2 * delta +
             (self.N0 + self.N0u * u + self.N0uu * u**2))

        xdot = np.zeros(7)
        xdot[0] = X * (U**2 / self.L) / m11
        xdot[1] = -(-m33 * Y + m23 * N) * (U**2 / self.L) / detM22
        xdot[2] = (-m32 * Y + m22 * N) * (U**2 / self.L**2) / detM22
        xdot[3] = (np.cos(psi) * (self.U0 / U + u) - np.sin(psi) * v) * U
        xdot[4] = (np.sin(psi) * (self.U0 / U + u) + np.cos(psi) * v) * U
        xdot[5] = r * (U / self.L)
        xdot[6] = 0.0  # rudder fixed

        return xdot, U

    def simulate(self, T=700.0):
        N = int(round(float(T) / self.h))
        if N < 1:
            N = 1

        x = self.x_initial.copy()
        out = np.zeros((N + 1, 10))  # t, states(7), U, thrust_factor

        for i in range(N + 1):
            t = i * self.h
            tf = self.thrust_factor_at(t)
            xdot, U = self.model(x, tf)

            out[i, 0] = t
            out[i, 1:8] = x
            out[i, 8] = U
            out[i, 9] = tf

            x = x + self.h * xdot

        t_series = out[:, 0]
        u_series = out[:, 1]
        v_series = out[:, 2]
        r_series = out[:, 3] * (180.0 / np.pi)
        x_series = out[:, 4]
        y_series = out[:, 5]
        psi_series = out[:, 6] * (180.0 / np.pi)
        U_series = out[:, 8]
        thrust_series = out[:, 9]
        delta_series = out[:, 7]  # x[6], rudder (fixed at 0)

        final_U = float(U_series[-1])
        stopping_distance = float(np.max(x_series))
        time_to_stop = float(t_series[-1])
        max_deviation_y = float(np.max(np.abs(y_series)))

        return (
            t_series,
            u_series,
            v_series,
            r_series,
            x_series,
            y_series,
            psi_series,
            U_series,
            thrust_series,
            delta_series,
            final_U,
            stopping_distance,
            time_to_stop,
            max_deviation_y,
        )


def warmup_numba():
    """
    No-op kept only so views.py (or app startup code) that calls
    engine.warmup_numba() doesn't break now that numba is gone.
    """
    pass