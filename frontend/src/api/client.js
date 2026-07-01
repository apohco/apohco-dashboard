import axios from 'axios';

// Central axios instance. AuthContext attaches the Cognito ID token to
// every request via attachAuthInterceptor (see context/AuthContext.jsx).
const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

export function attachAuthInterceptor(getIdToken) {
  apiClient.interceptors.request.use(async (config) => {
    const token = await getIdToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
}

export default apiClient;
