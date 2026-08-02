# maneuver/spiral/serializers.py
import numpy as np
from rest_framework import serializers


class SpiralInputSerializer(serializers.Serializer):
    U0 = serializers.FloatField()
    L = serializers.FloatField()
    m = serializers.FloatField()
    Iz = serializers.FloatField()
    xG = serializers.FloatField()

    T = serializers.FloatField(default=400.0, required=False)
    h = serializers.FloatField(default=0.1, required=False)
    T_delta = serializers.FloatField(default=1.0, required=False)

    x_initial = serializers.ListField(
        child=serializers.FloatField(),
        default=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        required=False
    )

    # ضرایب هیدرودینامیک
    Xudot = serializers.FloatField(default=0.0)
    Yvdot = serializers.FloatField(default=0.0)
    Nvdot = serializers.FloatField(default=0.0)
    Xu = serializers.FloatField(default=0.0)
    Yrdot = serializers.FloatField(default=0.0)
    Nrdot = serializers.FloatField(default=0.0)
    Xuu = serializers.FloatField(default=0.0)
    Yv = serializers.FloatField(default=0.0)
    Nv = serializers.FloatField(default=0.0)
    Xuuu = serializers.FloatField(default=0.0)
    Yr = serializers.FloatField(default=0.0)
    Nr = serializers.FloatField(default=0.0)
    Xvv = serializers.FloatField(default=0.0)
    Yvvv = serializers.FloatField(default=0.0)
    Nvvv = serializers.FloatField(default=0.0)
    Xrr = serializers.FloatField(default=0.0)
    Yvvr = serializers.FloatField(default=0.0)
    Nvvr = serializers.FloatField(default=0.0)
    Xdd = serializers.FloatField(default=0.0)
    Yvu = serializers.FloatField(default=0.0)
    Nvu = serializers.FloatField(default=0.0)
    Xudd = serializers.FloatField(default=0.0)
    Yru = serializers.FloatField(default=0.0)
    Nru = serializers.FloatField(default=0.0)
    Xrv = serializers.FloatField(default=0.0)
    Yd = serializers.FloatField(default=0.0)
    Nd = serializers.FloatField(default=0.0)
    Xvd = serializers.FloatField(default=0.0)
    Yddd = serializers.FloatField(default=0.0)
    Nddd = serializers.FloatField(default=0.0)
    Xuvd = serializers.FloatField(default=0.0)
    Yud = serializers.FloatField(default=0.0)
    Nud = serializers.FloatField(default=0.0)
    Yuud = serializers.FloatField(default=0.0)
    Nuud = serializers.FloatField(default=0.0)
    Yvdd = serializers.FloatField(default=0.0)
    Nvdd = serializers.FloatField(default=0.0)
    Yvvd = serializers.FloatField(default=0.0)
    Nvvd = serializers.FloatField(default=0.0)
    Y0 = serializers.FloatField(default=0.0)
    N0 = serializers.FloatField(default=0.0)
    Y0u = serializers.FloatField(default=0.0)
    N0u = serializers.FloatField(default=0.0)
    Y0uu = serializers.FloatField(default=0.0)
    N0uu = serializers.FloatField(default=0.0)

    def validate_x_initial(self, value):
        if len(value) != 7:
            raise serializers.ValidationError(
                "Initial state vector 'x_initial' must contain exactly 7 elements."
            )
        return np.array(value, dtype=np.float64)

    def validate_h(self, value):
        if value <= 0:
            raise serializers.ValidationError("h must be positive.")
        return value

    def validate_T(self, value):
        if value <= 0:
            raise serializers.ValidationError("T must be positive.")
        if value > 7200:
            raise serializers.ValidationError(
                "T is too large. Maximum allowed T is 7200 s."
            )
        return value

    def validate_T_delta(self, value):
        if value < 0:
            raise serializers.ValidationError("T_delta must be non-negative.")
        return value