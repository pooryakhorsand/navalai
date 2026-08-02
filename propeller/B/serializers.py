# maneuver/B/serializers.py
from rest_framework import serializers


class WageningenBSeriesInputSerializer(serializers.Serializer):
    Z = serializers.IntegerField(min_value=2, max_value=7, default=4)
    EAR = serializers.FloatField(min_value=0.30, max_value=1.05)
    PD_min = serializers.FloatField(default=0.50, min_value=0.50, max_value=1.40)
    PD_max = serializers.FloatField(default=1.40, min_value=0.50, max_value=1.40)
    Re = serializers.FloatField(default=2_000_000.0, min_value=2_000_000.0, max_value=9_000_000.0)
    J_steps = serializers.IntegerField(default=51, min_value=2, max_value=2000)
    PD_step = serializers.FloatField(default=0.15, min_value=0.01, max_value=1.0)

    def validate(self, attrs):
        if attrs["PD_max"] < attrs["PD_min"]:
            raise serializers.ValidationError("PD_max must be >= PD_min.")
        return attrs