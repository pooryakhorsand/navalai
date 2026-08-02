# navalai/urls.py
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.contrib.sitemaps.views import sitemap
from django.views.generic import TemplateView

from core.sitemaps import StaticViewSitemap

sitemaps = {
    "static": StaticViewSitemap,
}

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("core.urls", namespace="core")),
    
    path('test404/', TemplateView.as_view(template_name='404.html')),
    path('test500/', TemplateView.as_view(template_name='500.html')),

    # Maneuver
    path("turning/", include("maneuver.turning.urls", namespace="turning")),
    path("zigzag/", include("maneuver.zigzag.urls", namespace="zigzag")),
    path("stopping/", include("maneuver.stopping.urls", namespace="stopping")),
    path("spiral/", include("maneuver.spiral.urls", namespace="spiral")),
    path("pullout/", include("maneuver.pullout.urls", namespace="pullout")),
    path("williamson_turn/", include("maneuver.williamson.urls", namespace="williamson_turn")),
    path("anderson/", include("maneuver.anderson.urls", namespace="anderson")),

    # Resistance
    path("holtrop/", include("resistance.holtrop.urls", namespace="holtrop")),
    path("hollenbach/", include("resistance.hollenbach.urls", namespace="hollenbach")),
    path("savitsky/", include("resistance.savitsky.urls", namespace="savitsky")),
    path("yacht/", include("resistance.yacht.urls", namespace="yacht")),
    path("yacht_three/", include("resistance.yacht_three.urls", namespace="yacht_three")),

    # Propeller
    path("b_series/", include("propeller.B.urls", namespace="b_series")),
    path("au_series/", include("propeller.au.urls", namespace="au_series")),

    # Appendages
    path('ROTOR/', include('appendages.ROTOR.urls', namespace='ROTOR')),
    path('publications/', include('core.urls', namespace='publications')),

    # ═══════ SEO: sitemap & robots ═══════
    path(
        "sitemap.xml",
        sitemap,
        {"sitemaps": sitemaps},
        name="django.contrib.sitemaps.views.sitemap",
    ),
    path(
        "robots.txt",
        TemplateView.as_view(template_name="robots.txt", content_type="text/plain"),
        name="robots_txt",
    ),
]

if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)