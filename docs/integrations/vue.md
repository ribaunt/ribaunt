# Vue.js Integration Guide

Integrating Ribaunt CAPTCHA into a Vue 3 project is extremely straightforward since Vue natively understands Web Components.

Client-side solving relies on the Web Crypto API, so development should run in a secure context such as `https://...` or `http://localhost`. Plain local-network HTTP URLs may fail in some browsers.

## Registration

To use the widget without Vue warning about an "Unknown custom element", you must register it in your `vite.config.ts` or `vue.config.js`:

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Tell Vue that all tags starting with 'ribaunt-' are custom elements
          isCustomElement: (tag) => tag.startsWith('ribaunt-')
        }
      }
    })
  ]
})
```

## Using in a Component

Then, simply import the widget as a side-effect and use the `<ribaunt-widget>` tag directly in your templates. Use Vue's `@` syntax for event listeners and `:` syntax for bound properties.

```vue
<template>
  <form @submit.prevent="submitForm">
    <ribaunt-widget
      ref="widgetRef"
      challenge-endpoint="/api/captcha/challenge"
      verify-endpoint="/api/captcha/verify"
      auto-verify="true"
      :show-warning="showWarning"
      :solve-timeout="15000"
      :disabled="isDisabled"
      @verify="onVerify"
      @error="onError"
      @state-change="onStateChange"
    ></ribaunt-widget>

    <button type="submit" :disabled="!isVerified">Submit Form</button>
    <button type="button" @click="resetCaptcha">Reset</button>
  </form>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { RibauntWidgetElement, WidgetState } from 'ribaunt/widget'

// Register the web component
import 'ribaunt/widget'

const widgetRef = ref<RibauntWidgetElement | null>(null)
const isVerified = ref(false)
const showWarning = ref(false)
const isDisabled = ref(false)

const onVerify = (event: CustomEvent<{ solutions: any[] }>) => {
  console.log('Verified!', event.detail.solutions)
  isVerified.value = true
}

const onError = (event: CustomEvent<{ error: string }>) => {
  console.error('Error verifying:', event.detail.error)
  isVerified.value = false
}

const onStateChange = (event: CustomEvent<{ state: WidgetState }>) => {
  console.log('State changed to:', event.detail.state)
}

const resetCaptcha = () => {
  if (widgetRef.value) {
    widgetRef.value.reset()
    isVerified.value = false
  }
}

const submitForm = () => {
  if (isVerified.value) {
    // Proceed with form submission
    console.log('Form submitted securely!')
  }
}
</script>
```

Since Vue correctly passes properties down, everything is reactive!

When using `challenge-endpoint`, the recommended response shape is `{ challenges: string[] }`.

For backwards compatibility, the widget also accepts `{ tokens: string[] }` and raw `string[]`.

Use `auto-verify="true"` if the widget should start solving as soon as it mounts. If you bind `disabled`, note that the widget now treats it as a real interaction lock: clicks, keyboard activation, `startVerification()`, and `auto-verify` are blocked until the prop is cleared.

If the browser does not expose `crypto.subtle`, verification will fail with a clear error indicating that HTTPS or `localhost` is required.
