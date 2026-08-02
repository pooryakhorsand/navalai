/**
 * home.js — Dynamic Page Engine hydration handling
 */
// home.js
import { API } from './api.js';

document.addEventListener('DOMContentLoaded', () => {
    hydrateNavalApps();
    hydrateLiveMetrics();
});

/**
 * Attempts to poll Django backend server configuration for live tools data injection
 */
async function hydrateNavalApps() {
    const targetGrid = document.querySelector('#main-apps-grid');
    if (!targetGrid) return;

    try {
        const appsData = await API.get('/apps/');

        if (appsData && appsData.length > 0) {
            targetGrid.innerHTML = ''; // Safely drop embedded layout mockups

            appsData.forEach(item => {
                const element = document.createElement('div');
                element.className = 'app-card';
                element.innerHTML = `
                    <div class="app-icon">
                        <svg viewBox="0 0 24 24">
                            <path d="${item.svg_path || 'M12 2L2 7l10 5 10-5-10-5z'}"/>
                        </svg>
                    </div>
                    <div class="app-title">${item.title}</div>
                    <div class="app-desc">${item.description}</div>
                    <span class="app-tag">${item.tag || 'Active'}</span>
                `;
                targetGrid.appendChild(element);
            });
        }
    } catch (err) {
        console.warn('API connection failed. Retaining pre-compiled template tool cards.');
    }
}

/**
 * Loads dynamic status metrics values from database targets
 */
async function hydrateLiveMetrics() {
    try {
        const analytics = await API.get('/metrics/');
        if (analytics) {
            if (analytics.apps_count) document.querySelector('#metric-apps-count').textContent = analytics.apps_count;
            if (analytics.predictions_type) document.querySelector('#metric-predictions-type').textContent = analytics.predictions_type;
        }
    } catch (err) {
        // Quiet fallback to preserve standard hardcoded document layout parameters
    }
}