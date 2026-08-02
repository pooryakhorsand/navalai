# resistance/hollenbach/serializers.py
import math
from rest_framework import serializers


class HollenbachInputSerializer(serializers.Serializer):
    # ── Principal dimensions (required) ────────────────────────────
    LPP = serializers.FloatField(min_value=10.0, max_value=500.0)
    LWL = serializers.FloatField(min_value=10.0, max_value=500.0)
    LOS = serializers.FloatField(min_value=10.0, max_value=600.0)
    B   = serializers.FloatField(min_value=1.0,  max_value=100.0)
    T   = serializers.FloatField(min_value=0.5,  max_value=30.0)
    V   = serializers.FloatField(min_value=1.0)          # displacement volume m³
    AVS = serializers.FloatField(min_value=0.0)           # projected wind area m²
    dTH = serializers.FloatField(min_value=0.0)           # bow thruster diameter m
    D   = serializers.FloatField(min_value=0.1)           # propeller diameter m

    # ── Optional ───────────────────────────────────────────────────
    Ta  = serializers.FloatField(required=False, default=None)
    Tf  = serializers.FloatField(required=False, default=None)
    CDA = serializers.FloatField(required=False, default=0.8, min_value=0.0)

    # ── Speed range (knots) ────────────────────────────────────────
    Vl = serializers.FloatField(min_value=0.1, max_value=50.0)
    Vh = serializers.FloatField(min_value=0.1, max_value=60.0)

    # ── Legacy scalar appendage ────────────────────────────────────
    SAPP = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    k2i  = serializers.FloatField(required=False, default=0.4, min_value=0.0)

    # ── Individual appendage 1+k2 values ──────────────────────────
    behind_skeg       = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    behind_skeg_area  = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    behind_stern      = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    behind_stern_area = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    twin              = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    twin_area         = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    keel              = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    keel_area         = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    shaft             = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    shaft_area        = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    strut             = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    strut_area        = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    bracket           = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    bracket_area      = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    fin               = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    fin_area          = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    dome              = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    dome_area         = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    hull              = serializers.FloatField(required=False, default=0.0, min_value=0.0)
    hull_area         = serializers.FloatField(required=False, default=0.0, min_value=0.0)

    # ── Response format ────────────────────────────────────────────
    response_format = serializers.ChoiceField(
        choices=['json', 'compact'],
        required=False,
        default='json',
    )

    def validate(self, attrs):
        if attrs.get('Ta') is None:
            attrs['Ta'] = attrs['T']
        if attrs.get('Tf') is None:
            attrs['Tf'] = attrs['T']
        if attrs['Vl'] >= attrs['Vh']:
            raise serializers.ValidationError("Vl must be less than Vh.")
        return attrs