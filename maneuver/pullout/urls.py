from django.urls import path
from django.shortcuts import render
from .views import PulloutSimulationView

app_name = "pullout"


class PulloutCombinedView(PulloutSimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "maneuver/app_pullout.html")


urlpatterns = [
    path("", PulloutCombinedView.as_view(), name="pullout_main"),
]