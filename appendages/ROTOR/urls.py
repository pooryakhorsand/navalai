#appendates/ROTOR/urls.py
from django.urls import path
from .views import rotor_main

app_name = "ROTOR"

urlpatterns = [
    path("", rotor_main, name="ROTOR"),
]
