import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: () => import('../layouts/AppLayout.vue'),
      children: [
        { path: '', redirect: '/library' },
        { path: 'library', name: 'library', component: () => import('../views/LibraryView.vue') },
        { path: 'sources', name: 'sources', component: () => import('../views/SourcesView.vue') },
        { path: 'categories', name: 'categories', component: () => import('../views/CategoriesView.vue') },
        { path: 'actors', name: 'actors', component: () => import('../views/ActorsView.vue') },
        { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
      ],
    },
  ],
});
