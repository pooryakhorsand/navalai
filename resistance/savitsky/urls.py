# resistance/savitsky/urls.py
from django.urls import path
from django.shortcuts import render

from .views import SavitskySimulationView


app_name = "savitsky"


class SavitskyCombinedView(SavitskySimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "resistance/savitsky.html")


urlpatterns = [
    path("", SavitskyCombinedView.as_view(), name="savitsky_main"),
]