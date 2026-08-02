# resistance/yacht/urls.py

from django.urls import path
from django.shortcuts import render
from .views import YachtResistanceView

app_name = "yacht"


class YachtCombinedView(YachtResistanceView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "resistance/yacht.html")


urlpatterns = [
    path("", YachtCombinedView.as_view(), name="yacht_main"),
]