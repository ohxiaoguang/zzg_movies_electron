import { createRouter, createWebHashHistory } from 'vue-router';
import AppLayout from '../layouts/AppLayout.vue';
import LibraryView from '../views/LibraryView.vue';
import SourcesView from '../views/SourcesView.vue';
import CategoriesView from '../views/CategoriesView.vue';
import ActorsView from '../views/ActorsView.vue';
import SettingsView from '../views/SettingsView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', redirect: '/library' },
        { path: 'library', name: 'library', component: LibraryView },
        { path: 'sources', name: 'sources', component: SourcesView },
        { path: 'categories', name: 'categories', component: CategoriesView },
        { path: 'actors', name: 'actors', component: ActorsView },
        { path: 'settings', name: 'settings', component: SettingsView },
      ],
    },
  ],
});
