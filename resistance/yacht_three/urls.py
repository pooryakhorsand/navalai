# resistance/yacht_three/urls.py

from django.urls import path
from django.shortcuts import render
from .views import YachtThreeView

app_name = "yacht_three"


class YachtThreeCombinedView(YachtThreeView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "resistance/yacht_three.html")


urlpatterns = [
    path("", YachtThreeCombinedView.as_view(), name="yacht_three_main"),
]