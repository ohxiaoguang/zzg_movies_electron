<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { AccountAuthStatusDto } from '../shared/contracts';

const REMEMBERED_USERNAME_KEY = 'film-library-remembered-username';
const status = ref<AccountAuthStatusDto | null>(null);
const statusError = ref('');
const submitting = ref(false);
const formError = ref('');
const form = reactive({
  username: localStorage.getItem(REMEMBERED_USERNAME_KEY) ?? '',
  password: '',
  confirmation: '',
  rememberUsername: localStorage.getItem(REMEMBERED_USERNAME_KEY) !== null,
});
let statusTimer: number | null = null;

const needsSetup = computed(() => status.value?.configured === false);

onMounted(() => {
  void refreshStatus();
  statusTimer = window.setInterval(() => void refreshStatus(true), 2_000);
});

onBeforeUnmount(() => {
  if (statusTimer !== null) window.clearInterval(statusTimer);
});

async function refreshStatus(silent = false): Promise<void> {
  const result = await window.filmLibrary.account.status();
  if (result.ok) {
    const credentialsWereConfigured = status.value?.configured === true;
    status.value = result.data;
    statusError.value = '';
    if (credentialsWereConfigured && !result.data.configured) {
      form.password = '';
      form.confirmation = '';
    }
    return;
  }
  if (!silent || !status.value?.authenticated) {
    status.value = null;
    statusError.value = result.error.message;
  }
}

async function submit(): Promise<void> {
  formError.value = '';
  if (needsSetup.value && form.password !== form.confirmation) {
    formError.value = '两次输入的密码不一致';
    return;
  }
  submitting.value = true;
  try {
    const input = { username: form.username, password: form.password };
    const result = needsSetup.value
      ? await window.filmLibrary.account.setup(input)
      : await window.filmLibrary.account.login(input);
    if (!result.ok) {
      formError.value = result.error.message;
      await refreshStatus(true);
      return;
    }
    if (form.rememberUsername) localStorage.setItem(REMEMBERED_USERNAME_KEY, form.username.trim());
    else localStorage.removeItem(REMEMBERED_USERNAME_KEY);
    form.password = '';
    form.confirmation = '';
    status.value = result.data;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <RouterView v-if="status?.authenticated" />
  <main v-else class="account-screen">
    <section class="account-card">
      <div class="brand-mark">FL</div>
      <p class="eyebrow">LOCAL FILM LIBRARY</p>
      <h1>{{ needsSetup ? '首次设置账号' : '登录影片库' }}</h1>
      <p class="account-description">
        {{ needsSetup ? '设置后，客户端和局域网网页都使用这套账号密码。' : '输入账号密码后进入客户端。' }}
      </p>

      <form v-if="status" @submit.prevent="submit">
        <label>
          <span>账号</span>
          <input v-model="form.username" name="username" autocomplete="username" maxlength="64" :autofocus="!form.username" required />
        </label>
        <label>
          <span>密码</span>
          <input v-model="form.password" name="password" type="password" :autocomplete="needsSetup ? 'new-password' : 'current-password'" :autofocus="Boolean(form.username)" minlength="1" required />
        </label>
        <label v-if="needsSetup">
          <span>确认密码</span>
          <input v-model="form.confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="1" required />
        </label>
        <label class="remember-row">
          <input v-model="form.rememberUsername" type="checkbox" />
          <span>记住账号</span>
        </label>
        <p v-if="formError" class="account-error">{{ formError }}</p>
        <button type="submit" :disabled="submitting">{{ submitting ? '请稍候…' : needsSetup ? '创建账号并进入' : '登录' }}</button>
      </form>

      <p v-if="statusError" class="account-error">{{ statusError }}</p>
      <p v-if="!status && !statusError" class="account-description">正在读取账号状态…</p>
      <p v-if="status?.credentialFilePath" class="credential-note">
        忘记账号密码时，可关闭应用后手动删除凭据文件并重新打开：<code>{{ status.credentialFilePath }}</code>
      </p>
    </section>
  </main>
</template>

<style scoped>
.account-screen { min-height: 100vh; display: grid; place-items: center; padding: 32px; color: #edf1f7; background: radial-gradient(circle at 20% 10%, rgba(152, 227, 194, .09), transparent 34%), #0f1117; }
.account-card { width: min(420px, 100%); padding: 38px; border: 1px solid #303746; border-radius: 18px; background: rgba(23, 27, 37, .96); box-shadow: 0 22px 80px rgba(0, 0, 0, .35); }
.brand-mark { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 14px; color: #102018; background: #98e3c2; font-weight: 900; letter-spacing: -.04em; }
.eyebrow { margin: 24px 0 7px; color: #98e3c2; font-size: 10px; font-weight: 800; letter-spacing: .18em; }
h1 { margin: 0; font-size: 27px; }
.account-description { margin: 10px 0 24px; color: #aeb8ca; font-size: 13px; line-height: 1.65; }
form { display: grid; gap: 15px; }
label { display: grid; gap: 7px; color: #bac3d0; font-size: 12px; }
input:not([type='checkbox']) { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #394253; border-radius: 9px; outline: none; color: #edf1f7; background: #11151d; font: inherit; }
input:not([type='checkbox']):focus { border-color: #98e3c2; box-shadow: 0 0 0 3px rgba(152, 227, 194, .1); }
.remember-row { display: flex; align-items: center; gap: 8px; }
.remember-row input { accent-color: #98e3c2; }
button { padding: 12px 16px; border: 0; border-radius: 9px; color: #102018; background: #98e3c2; font-weight: 800; cursor: pointer; }
button:disabled { cursor: wait; opacity: .65; }
.account-error { margin: 0; padding: 10px 12px; border: 1px solid rgba(255, 116, 116, .25); border-radius: 8px; color: #ffb3b3; background: rgba(255, 116, 116, .07); font-size: 12px; line-height: 1.5; }
.credential-note { margin: 24px 0 0; padding-top: 18px; border-top: 1px solid #303746; color: #7f8a9e; font-size: 10px; line-height: 1.6; }
.credential-note code { display: block; margin-top: 5px; overflow-wrap: anywhere; color: #aeb8ca; }
</style>
