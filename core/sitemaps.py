from django.contrib.sitemaps import Sitemap
from django.urls import reverse


class StaticViewSitemap(Sitemap):
    priority = 0.8
    changefreq = "monthly"

    def items(self):
        return [
            "core:home",
            "core:about",
            "core:publications",
            "holtrop:holtrop_main",
            "savitsky:savitsky_main",
            "hollenbach:hollenbach_main",
            "yacht:yacht_main",
            "yacht_three:yacht_three_main",
            "b_series:b_series_main",
            "au_series:au_main",
            "ROTOR:ROTOR",
            "turning:turning_main",
            "zigzag:zigzag_main",
            "stopping:stopping_main",
            "spiral:spiral_main",
            "pullout:pullout_main",
            "williamson_turn:williamson_main",
            "anderson:anderson_main",
        ]

    def location(self, item):
        return reverse(item)

    def priority(self, item):
        return 1.0 if item == "core:home" else 0.7
