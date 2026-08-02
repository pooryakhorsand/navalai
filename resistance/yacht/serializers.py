# resistance/yacht/serializers.py

import numpy as np
from rest_framework import serializers


class YachtInputSerializer(serializers.Serializer):
    L = serializers.FloatField()
    B = serializers.FloatField()
    T = serializers.FloatField()

    displacement = serializers.FloatField(required=False, allow_null=True)
    lcb = serializers.FloatField(required=False, allow_null=True)
    Pc = serializers.FloatField(required=False, allow_null=True)

    response_format = serializers.ChoiceField(
        choices=["json", "compact"],
        default="json",
        required=False
    )
    output_stride = serializers.IntegerField(
        default=1, min_value=1, max_value=500, required=False
    )