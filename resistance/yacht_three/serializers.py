# resistance/yacht_three/serializers.py

from rest_framework import serializers


class YachtThreeInputSerializer(serializers.Serializer):
    L = serializers.FloatField()
    B = serializers.FloatField()
    T = serializers.FloatField()

    response_format = serializers.ChoiceField(
        choices=["json", "compact"],
        default="json",
        required=False
    )
    output_stride = serializers.IntegerField(
        default=1, min_value=1, max_value=500, required=False
    )