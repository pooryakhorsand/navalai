# appendages/ROTOR/views.py
from django.shortcuts import render


def rotor_main(request):
    return render(request, "appendages/ROTOR.html")