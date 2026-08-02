# maneuver/holtrop/serializers.py
from rest_framework import serializers


class HoltropInputSerializer(serializers.Serializer):
    # Hull main particulars (required)
    wl = serializers.FloatField()
    beam = serializers.FloatField()
    df = serializers.FloatField()
    da = serializers.FloatField()
    lcb = serializers.FloatField()
    cb = serializers.FloatField()
    cm = serializers.FloatField()
    cwl = serializers.FloatField()

    # Hull shape flags
    bulbous = serializers.FloatField(default=0.0, required=False)
    transom = serializers.FloatField(default=0.0, required=False)
    aft_body = serializers.IntegerField(default=2, required=False)

    # Appendage coefficients + areas
    dome = serializers.FloatField(default=0.0, required=False)
    dome_area = serializers.FloatField(default=0.0, required=False)
    keel = serializers.FloatField(default=0.0, required=False)
    keel_area = serializers.FloatField(default=0.0, required=False)
    behind_skeg = serializers.FloatField(default=0.0, required=False)
    behind_skeg_area = serializers.FloatField(default=0.0, required=False)
    behind_stern = serializers.FloatField(default=0.0, required=False)
    behind_stern_area = serializers.FloatField(default=0.0, required=False)
    twin = serializers.FloatField(default=0.0, required=False)
    twin_area = serializers.FloatField(default=0.0, required=False)
    bracket = serializers.FloatField(default=0.0, required=False)
    bracket_area = serializers.FloatField(default=0.0, required=False)
    skeg = serializers.FloatField(default=0.0, required=False)
    skeg_area = serializers.FloatField(default=0.0, required=False)
    strut = serializers.FloatField(default=0.0, required=False)
    strut_area = serializers.FloatField(default=0.0, required=False)
    hull = serializers.FloatField(default=0.0, required=False)
    hull_area = serializers.FloatField(default=0.0, required=False)
    shaft = serializers.FloatField(default=0.0, required=False)
    shaft_area = serializers.FloatField(default=0.0, required=False)
    fin = serializers.FloatField(default=0.0, required=False)
    fin_area = serializers.FloatField(default=0.0, required=False)

    # Output controls
    N = serializers.IntegerField(default=41, required=False)
    response_format = serializers.CharField(default="json", required=False)