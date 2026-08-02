# core/views.py
from django.shortcuts import render


def home_view(request):
	return render(request, "core/index.html")


def publications_view(request):
	return render(request, "core/publications.html")


def publications_yacht(request):
	return render(request, "core/yacht_published.html")


def publications_yacht_three(request):
	return render(request, "core/published_three.html")


def publications_RAG(request):
	return render(request, "core/rag_published.html")


def about_view(request):
	return render(request, "core/about.html")
