# resistance/hollenbach/urls.py
from django.urls import path
from django.shortcuts import render
from .views import HollenbachSimulationView

app_name = "hollenbach"


class HollenbachCombinedView(HollenbachSimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "resistance/hollenbach.html")


urlpatterns = [
    path("", HollenbachCombinedView.as_view(), name="hollenbach_main"),
]