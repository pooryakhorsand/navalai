# maneuver/turning/urls.py
from django.urls import path
from django.shortcuts import render
from .views import TurningSimulationView

app_name = "turning"


class TurningCombinedView(TurningSimulationView):
   http_method_names = ["get", "post", "options"]   # این خط اضافه شد

   def get(self, request, *args, **kwargs):
      return render(request, "maneuver/turning.html")


urlpatterns = [
   path("", TurningCombinedView.as_view(), name="turning_main"),
]
