import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh/translation.json';
import en from './locales/en/translation.json';

// Desktop: language is managed by the Rust backend.
// App.tsx calls invoke('get_language') on startup to set the initial language.

i18n
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    lng: 'zh',
    fallbackLng: 'zh',
    debug: false,
    interpolation: { escapeValue: false },
  });

export default i18n;
