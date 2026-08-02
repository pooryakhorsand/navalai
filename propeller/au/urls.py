# propeller/au/urls.py
from django.shortcuts import render
from django.urls import path

from .views import AUSeriesSimulationView

app_name = "au_series"


class AUSeriesCombinedView(AUSeriesSimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "propeller/au.html")


urlpatterns = [
    path("", AUSeriesCombinedView.as_view(), name="au_main"),
]