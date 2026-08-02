# maneuver/spiral/urls.py
from django.urls import path

from .views import SpiralCombinedView

app_name = "spiral"

urlpatterns = [
    path("", SpiralCombinedView.as_view(), name="spiral_main"),
]