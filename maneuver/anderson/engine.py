# maneuver/anderson/engine.py
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
def _simulate_anderson_core(x0, h, N, psi_target_rad, delta_hard_rad,
                            max_rudder_rate, U0, L, m, Iz, xG, coef):
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
	
	xout = np.empty((N + 1, 11), dtype=np.float64)
	x = x0.copy()
	
	phase = 1
	ui = -delta_hard_rad
	t_end = 0.0
	
	inv_l = 1.0 / L
	inv_l2 = inv_l * inv_l
	two_pi = 2.0 * np.pi
	
	for i in range(N + 1):
		time = i * h
		
		if phase == 1:
			current_psi = x[5]
			current_psi_wrapped = (current_psi + np.pi) % two_pi - np.pi
			if (delta_hard_rad > 0 and current_psi_wrapped >= psi_target_rad) or \
					(
							delta_hard_rad < 0 and current_psi_wrapped <= psi_target_rad):
				phase = 2
				ui = 0.0
				t_end = time
		
		delta_c = -ui
		delta = x[6]
		delta_dot = delta_c - delta
		if delta_dot < -max_rudder_rate:
			delta_dot = -max_rudder_rate
		elif delta_dot > max_rudder_rate:
			delta_dot = max_rudder_rate
		
		U_val = np.sqrt((U0 + x[0]) ** 2 + x[1] ** 2)
		if U_val < 1e-12:
			U_val = 1e-12
		
		u = x[0] / U_val
		v = x[1] / U_val
		r = x[2] * L / U_val
		psi = x[5]
		
		u2 = u * u
		u3 = u2 * u
		v2 = v * v
		v3 = v2 * v
		r2 = r * r
		d2 = delta * delta
		d3 = d2 * delta
		
		X_force = (
				Xu * u
				+ Xuu * u2
				+ Xuuu * u3
				+ Xvv * v2
				+ Xrr * r2
				+ Xrv * r * v
				+ Xdd * d2
				+ Xudd * u * d2
				+ Xvd * v * delta
				+ Xuvd * u * v * delta
		)
		
		Y_force = (
				Yv * v
				+ Yr * r
				+ Yvvv * v3
				+ Yvvr * v2 * r
				+ Yvu * v * u
				+ Yru * r * u
				+ Yd * delta
				+ Yddd * d3
				+ Yud * u * delta
				+ Yuud * u2 * delta
				+ Yvdd * v * d2
				+ Yvvd * v2 * delta
				+ (Y0 + Y0u * u + Y0uu * u2)
		)
		
		N_force = (
				Nv * v
				+ Nr * r
				+ Nvvv * v3
				+ Nvvr * v2 * r
				+ Nvu * v * u
				+ Nru * r * u
				+ Nd * delta
				+ Nddd * d3
				+ Nud * u * delta
				+ Nuud * u2 * delta
				+ Nvdd * v * d2
				+ Nvvd * v2 * delta
				+ (N0 + N0u * u + N0uu * u2)
		)
		
		U2 = U_val * U_val
		
		xdot0 = X_force * (U2 * inv_l) / m11
		xdot1 = -(-m33 * Y_force + m23 * N_force) * (U2 * inv_l) / detM22
		xdot2 = (-m32 * Y_force + m22 * N_force) * (U2 * inv_l2) / detM22
		
		cpsi = np.cos(psi)
		spsi = np.sin(psi)
		
		xdot3 = (cpsi * (U0 / U_val + u) - spsi * v) * U_val
		xdot4 = (spsi * (U0 / U_val + u) + cpsi * v) * U_val
		xdot5 = r * (U_val * inv_l)
		xdot6 = delta_dot
		
		xout[i, 0] = time
		xout[i, 1] = x[0]
		xout[i, 2] = x[1]
		xout[i, 3] = x[2]
		xout[i, 4] = x[3]
		xout[i, 5] = x[4]
		xout[i, 6] = x[5]
		xout[i, 7] = U_val
		xout[i, 8] = x[6]
		xout[i, 9] = ui
		xout[i, 10] = phase
		
		x[0] += h * xdot0
		x[1] += h * xdot1
		x[2] += h * xdot2
		x[3] += h * xdot3
		x[4] += h * xdot4
		x[5] += h * xdot5
		x[6] += h * xdot6
	
	return xout, t_end


class AndersonTurnModel:
	def __init__(
			self,
			U0,
			L,
			m,
			Iz,
			xG,
			h=0.1,
			Tmax=1200.0,
			psi_target_deg=100.0,
			delta_hard_deg=35.0,
			max_rudder_rate_deg=5.0,
			x0=None,
			**coef_kwargs
	):
		if x0 is None:
			x0 = np.zeros(7, dtype=np.float64)
		
		self.x_initial = np.asarray(x0, dtype=np.float64).copy()
		self.U0 = float(U0)
		self.L = float(L)
		self.h = float(h)
		self.Tmax = float(Tmax)
		self.m = float(m)
		self.Iz = float(Iz)
		self.xG = float(xG)
		
		self.psi_target_rad = np.radians(psi_target_deg)
		self.psi_target_rad = (self.psi_target_rad + np.pi) % (
					2 * np.pi) - np.pi
		self.delta_hard_rad = np.radians(delta_hard_deg)
		self.max_rudder_rate = np.radians(max_rudder_rate_deg)
		
		self.coef = np.array(
			[float(coef_kwargs.get(name, 0.0)) for name in _COEF_ORDER],
			dtype=np.float64
		)
	
	def simulate(self):
		N = int(round(self.Tmax / self.h))
		if N < 1:
			N = 1
		
		xout, t_end = _simulate_anderson_core(
			self.x_initial,
			self.h,
			N,
			self.psi_target_rad,
			self.delta_hard_rad,
			self.max_rudder_rate,
			self.U0,
			self.L,
			self.m,
			self.Iz,
			self.xG,
			self.coef
		)
		
		t_series = xout[:, 0]
		u_series = xout[:, 1]
		v_series = xout[:, 2]
		r_series = xout[:, 3]
		x_series = xout[:, 4]
		y_series = xout[:, 5]
		psi_series = xout[:, 6]
		U_series = xout[:, 7]
		delta_series = xout[:, 8]
		ui_series = xout[:, 9]
		phase_series = xout[:, 10]
		
		final_psi_rad = psi_series[-1]
		final_psi_wrapped_rad = (final_psi_rad + np.pi) % (2 * np.pi) - np.pi
		final_psi_deg = np.degrees(final_psi_wrapped_rad)
		psi_target_deg_normalized = np.degrees(self.psi_target_rad)
		heading_error_deg = float(
			np.abs(final_psi_deg - psi_target_deg_normalized))
		cross_track_error_m = float(np.abs(y_series[-1]))
		
		delta_actual_deg = np.degrees(delta_series)
		rudder_cmd_deg = np.degrees(ui_series)
		
		safe_U = np.maximum(U_series, 0.1)
		r_rad_s = r_series * self.L / safe_U
		r_deg_s = np.degrees(r_rad_s)
		psi_deg = np.degrees(psi_series)
		
		return {
			"t_series": t_series,
			"psi_deg": psi_deg,
			"r_deg_s": r_deg_s,
			"rudder_cmd_deg": rudder_cmd_deg,
			"delta_actual_deg": delta_actual_deg,
			"x_series": x_series,
			"y_series": y_series,
			"t_end": float(t_end),
			"cross_track_error_m": cross_track_error_m,
			"heading_error_deg": heading_error_deg,
			"phase_series": phase_series,
			"sample_count": len(t_series)
		}


def warmup_numba():
	if not NUMBA_AVAILABLE:
		return
	
	x0 = np.zeros(7, dtype=np.float64)
	coef = np.zeros(len(_COEF_ORDER), dtype=np.float64)
	
	_simulate_anderson_core(
		x0,
		0.1,
		1,
		0.0,
		0.0,
		0.1,
		7.0,
		160.0,
		0.00798,
		0.000392,
		-0.023,
		coef
	)