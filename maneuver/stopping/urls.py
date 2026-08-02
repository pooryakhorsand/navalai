from django.urls import path
from django.shortcuts import render
from .views import ShipStoppingSimulationView

app_name = "stopping"


class ShipStoppingCombinedView(ShipStoppingSimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "maneuver/stopping.html")


urlpatterns = [
    path("", ShipStoppingCombinedView.as_view(), name="stopping_main"),
]