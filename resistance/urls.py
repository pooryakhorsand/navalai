# propeller/urls.py
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("core.urls", namespace="core")),
    path("B/", include("propeller.B.urls", namespace="B")),
    path("savitsky/", include("resistance.savitsky.urls", namespace="savitsky")),
    path("hollenbach/", include("resistance.hollenbach.urls", namespace="hollenbach")),
    path("yacht/", include("resistance.yacht.urls", namespace="yacht")),
    path("yacht_three/", include("resistance.yacht_three.urls", namespace="yacht_three")),
]

if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)