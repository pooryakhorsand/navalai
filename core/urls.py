# core/urls.py
from django.urls import path
from .views import home_view, publications_view, publications_yacht, publications_yacht_three, publications_RAG, about_view

app_name = "core"

urlpatterns = [
	path("", home_view, name="home"),
	path("publications/", publications_view, name="publications"),
	path("publications_yacht/", publications_yacht, name="publications_yacht"),
	path("publications_yacht_three/", publications_yacht_three, name="publications_yacht_three"),
	path("publications_RAG/", publications_RAG, name="publications_RAG"),
	path("about/", about_view, name="about"),
	
	
	
]