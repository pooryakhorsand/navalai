# maneuver/B/urls.py
from django.urls import path
from django.shortcuts import render
from .views import WageningenBSeriesView

app_name = "b_series"


class BSeriesCombinedView(WageningenBSeriesView):
    http_method_names = ["get"]

    def get(self, request, *args, **kwargs):
        return render(request, "propeller/b_series.html")


urlpatterns = [
    path("", BSeriesCombinedView.as_view(), name="b_series_main"),
    path("calculate/", WageningenBSeriesView.as_view(), name="b_series_calculate"),
]