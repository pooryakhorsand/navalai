# maneuver/holtrop/urls.py
from django.urls import path
from django.shortcuts import render
from .views import HoltropResistanceView

app_name = "holtrop"


class HoltropCombinedView(HoltropResistanceView):
    http_method_names = ["get", "post", "options"]

    def get(self, request, *args, **kwargs):
        # مسیر تمپلیت اصلاح شد تا به پوشه maneuver اشاره کند
        return render(request, "resistance/holtrop.html")


urlpatterns = [
    path("", HoltropCombinedView.as_view(), name="holtrop_main"),
]