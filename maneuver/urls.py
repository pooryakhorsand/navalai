# maneuver/urls.py
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('core.urls', namespace='core')),
    path('turning/', include('maneuver.turning.urls', namespace='turning')),
    path('zigzag/', include('maneuver.zigzag.urls', namespace='zigzag')),
    path('stopping/', include('maneuver.stopping.urls', namespace='stopping')),
    path('spiral/', include('maneuver.spiral.urls', namespace='spiral')),
    path('pullout/', include('maneuver.pullout.urls', namespace='pullout')),
    path('williamson/', include('maneuver.williamson.urls', namespace='williamson')),
    path('anderson/', include('maneuver.anderson.urls', namespace='anderson')),
    
]

if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)