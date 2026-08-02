# maneuver/anderson/urls.py
from django.urls import path
from .views import AndersonSimulationView, AndersonCombinedView

app_name = "anderson"

urlpatterns = [
    path("", AndersonCombinedView.as_view(), name="anderson_main"),
    path("simulate/", AndersonSimulationView.as_view(), name="anderson_simulate"),
]