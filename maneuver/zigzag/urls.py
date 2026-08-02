# maneuver/zigzag/urls.py
from django.urls import path
from .views import ZigzagSimulationView

app_name = "zigzag"

urlpatterns = [
    path("", ZigzagSimulationView.as_view(), name="zigzag_main"),
]