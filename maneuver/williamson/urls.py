# maneuver/williamsom/urls.py
from django.urls import path
from django.shortcuts import render
from .views import WilliamsonTurnSimulationView

app_name = "williamson_turn"


class WilliamsonTurnCombinedView(WilliamsonTurnSimulationView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        return render(request, "maneuver/williamson.html")


urlpatterns = [
    # نام این مسیر را از williamson_turn_main به williamson_main تغییر دادیم
    path("", WilliamsonTurnCombinedView.as_view(), name="williamson_main"),
]