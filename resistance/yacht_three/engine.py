# resistance/yacht_three/engine.py
"""
Yacht Three-Parameter (L, B, T) predictor.

This app takes only the three primary hull dimensions and predicts the
remaining hydrodynamic parameters (lcb, Pc, displacement) via
YachtCalculation, then runs the same resistance solver used by the
full Yacht Resistance Predictor.

No duplicated math lives here — we import directly from the yacht app's
engine so both apps always stay in sync.
"""

from resistance.yacht.engine import YachtCalculation, yacht_calculate_resistances


def yacht_three_calculate(L, B, T):
    """
    Predict missing hull parameters from (L, B, T) alone, then solve
    the resistance curve.

    Returns
    -------
    dict with keys:
        "parameters"  — dict from YachtCalculation.get_results()
        "resistances" — dict of 1-D float64 numpy arrays
                         (froude_series, residuary_series,
                          friction_series, total_series)
    """
    yacht = YachtCalculation(L, B, T)
    parameters = yacht.get_results()

    resistances = yacht_calculate_resistances(
        L=L,
        B=B,
        T=T,
        lcb=yacht.lcb,
        Pc=yacht.Pc,
        displacement=yacht.displacement,
    )

    return {
        "parameters": parameters,
        "resistances": resistances,
    }