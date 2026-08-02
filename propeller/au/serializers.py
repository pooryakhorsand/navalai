# propeller/au/serializers.py
from rest_framework import serializers


class AUSeriesInputSerializer(serializers.Serializer):
    Z = serializers.FloatField(default=5)
    AE_AO = serializers.FloatField(default=0.55)
    P_D = serializers.FloatField(default=1.00)
    D = serializers.FloatField(default=4.00)
    rR = serializers.FloatField(default=0.70)