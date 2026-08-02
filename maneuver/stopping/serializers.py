import numpy as np
from rest_framework import serializers


class ShipStoppingInputSerializer(serializers.Serializer):
    U0 = serializers.FloatField(default=7.7175, required=False)
    L = serializers.FloatField(default=160.93, required=False)
    m = serializers.FloatField(default=798e-5, required=False)
    Iz = serializers.FloatField(default=39.2e-5, required=False)
    xG = serializers.FloatField(default=-0.023, required=False)
    h = serializers.FloatField(default=0.1, required=False)
    T = serializers.FloatField(default=700.0, required=False)
    thrust_reduction_time = serializers.FloatField(default=20.0, required=False)
    reverse_thrust = serializers.FloatField(default=-0.4, required=False)

    x_initial = serializers.ListField(
        child=serializers.FloatField(),
        default=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        required=False
    )

    # Hydrodynamic coefficients
    Xudot = serializers.FloatField(default=-42e-5, required=False)
    Yvdot = serializers.FloatField(default=-748e-5, required=False)
    Nvdot = serializers.FloatField(default=4.646e-5, required=False)
    Xu = serializers.FloatField(default=-184e-5, required=False)
    Yrdot = serializers.FloatField(default=-9.354e-5, required=False)
    Nrdot = serializers.FloatField(default=-43.8e-5, required=False)
    Xuu = serializers.FloatField(default=-110e-5, required=False)
    Yv = serializers.FloatField(default=-1160e-5, required=False)
    Nv = serializers.FloatField(default=-264e-5, required=False)
    Xuuu = serializers.FloatField(default=-215e-5, required=False)
    Yr = serializers.FloatField(default=-499e-5, required=False)
    Nr = serializers.FloatField(default=-166e-5, required=False)
    Xvv = serializers.FloatField(default=-899e-5, required=False)
    Yvvv = serializers.FloatField(default=-8078e-5, required=False)
    Nvvv = serializers.FloatField(default=1636e-5, required=False)
    Xrr = serializers.FloatField(default=18e-5, required=False)
    Yvvr = serializers.FloatField(default=15356e-5, required=False)
    Nvvr = serializers.FloatField(default=-5483e-5, required=False)
    Xdd = serializers.FloatField(default=-95e-5, required=False)
    Yvu = serializers.FloatField(default=-1160e-5, required=False)
    Nvu = serializers.FloatField(default=-264e-5, required=False)
    Xudd = serializers.FloatField(default=-190e-5, required=False)
    Yru = serializers.FloatField(default=-499e-5, required=False)
    Nru = serializers.FloatField(default=-166e-5, required=False)
    Xrv = serializers.FloatField(default=798e-5, required=False)
    Yd = serializers.FloatField(default=278e-5, required=False)
    Nd = serializers.FloatField(default=-139e-5, required=False)
    Xvd = serializers.FloatField(default=93e-5, required=False)
    Yddd = serializers.FloatField(default=-90e-5, required=False)
    Nddd = serializers.FloatField(default=45e-5, required=False)
    Xuvd = serializers.FloatField(default=93e-5, required=False)
    Yud = serializers.FloatField(default=556e-5, required=False)
    Nud = serializers.FloatField(default=-278e-5, required=False)
    Yuud = serializers.FloatField(default=278e-5, required=False)
    Nuud = serializers.FloatField(default=-139e-5, required=False)
    Yvdd = serializers.FloatField(default=-4e-5, required=False)
    Nvdd = serializers.FloatField(default=13e-5, required=False)
    Yvvd = serializers.FloatField(default=1190e-5, required=False)
    Nvvd = serializers.FloatField(default=-489e-5, required=False)
    Y0 = serializers.FloatField(default=-4e-5, required=False)
    N0 = serializers.FloatField(default=3e-5, required=False)
    Y0u = serializers.FloatField(default=-8e-5, required=False)
    N0u = serializers.FloatField(default=6e-5, required=False)
    Y0uu = serializers.FloatField(default=-4e-5, required=False)
    N0uu = serializers.FloatField(default=3e-5, required=False)

    response_format = serializers.CharField(default="json", required=False)
    output_stride = serializers.IntegerField(default=1, min_value=1, max_value=500, required=False)

    def validate_x_initial(self, value):
        if len(value) != 7:
            raise serializers.ValidationError("Initial state vector 'x_initial' must contain exactly 7 elements.")
        return np.array(value, dtype=np.float64)

    def validate_T(self, value):
        if value <= 0:
            raise serializers.ValidationError("T must be positive.")
        if value > 7200:
            raise serializers.ValidationError("T is too large. Maximum allowed T is 7200 s.")
        return value

    def validate_h(self, value):
        if value <= 0:
            raise serializers.ValidationError("h must be positive.")
        return value

    def validate_thrust_reduction_time(self, value):
        if value < 0:
            raise serializers.ValidationError("thrust_reduction_time must be non-negative.")
        return value

    def validate_reverse_thrust(self, value):
        if value < -1.0 or value > 1.0:
            raise serializers.ValidationError("reverse_thrust must be between -1.0 and 1.0.")
        return value