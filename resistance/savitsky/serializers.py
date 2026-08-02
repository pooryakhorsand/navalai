# resistance/savitsky/serializers.py
import math
from rest_framework import serializers


class SavitskyInputSerializer(serializers.Serializer):
    speed = serializers.FloatField()
    weight = serializers.FloatField()
    beam = serializers.FloatField()
    length = serializers.FloatField()
    lcg = serializers.FloatField()
    vcg = serializers.FloatField()
    beta = serializers.FloatField()

    epsilon = serializers.FloatField(default=0.0, required=False)
    Lf = serializers.FloatField(default=0.0, required=False)
    sigma = serializers.FloatField(default=0.0, required=False)
    delta = serializers.FloatField(default=0.0, required=False)
    H_sig = serializers.FloatField(default=0.0, required=False)

    wetted_lengths_type = serializers.IntegerField(default=3, required=False)
    roughness_penalty_type = serializers.IntegerField(default=2, required=False)

    def validate(self, attrs):
        for key, value in attrs.items():
            if isinstance(value, float) and not math.isfinite(value):
                raise serializers.ValidationError(f"{key} must be finite.")

        if attrs["speed"] <= 0:
            raise serializers.ValidationError("speed must be positive.")

        if attrs["weight"] <= 0:
            raise serializers.ValidationError("weight must be positive.")

        if attrs["beam"] <= 0:
            raise serializers.ValidationError("beam must be positive.")

        if attrs["length"] <= 0:
            raise serializers.ValidationError("length must be positive.")

        if attrs["lcg"] < 0 or attrs["lcg"] > attrs["length"]:
            raise serializers.ValidationError("lcg must be between 0 and length.")

        if attrs["vcg"] < 0:
            raise serializers.ValidationError("vcg must be non-negative.")

        if attrs["beta"] < 0 or attrs["beta"] > 45:
            raise serializers.ValidationError("beta must be between 0 and 45 degrees.")

        if attrs.get("Lf", 0.0) < 0:
            raise serializers.ValidationError("Lf must be non-negative.")

        if attrs.get("H_sig", 0.0) < 0:
            raise serializers.ValidationError("H_sig must be non-negative.")

        wetted_type = int(attrs.get("wetted_lengths_type", 3))
        roughness_type = int(attrs.get("roughness_penalty_type", 2))

        attrs["wetted_lengths_type"] = min(max(wetted_type, 1), 3)
        attrs["roughness_penalty_type"] = min(max(roughness_type, 0), 3)

        return attrs