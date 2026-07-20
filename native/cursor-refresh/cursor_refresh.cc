#include <node_api.h>
#include <windows.h>

namespace {

void SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  napi_set_named_property(env, object, name, result);
}

void SetInt(napi_env env, napi_value object, const char* name, int64_t value) {
  napi_value result;
  napi_create_int64(env, value, &result);
  napi_set_named_property(env, object, name, result);
}

napi_value RefreshCursor(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);

  POINT point{};
  if (!GetCursorPos(&point)) {
    SetBool(env, result, "refreshed", false);
    SetInt(env, result, "error", GetLastError());
    return result;
  }

  HWND target = WindowFromPoint(point);
  if (target == nullptr) {
    SetBool(env, result, "refreshed", false);
    SetInt(env, result, "error", 0);
    return result;
  }

  // WM_NCHITTEST expects signed screen coordinates packed into 16-bit words.
  const LPARAM screen_point = MAKELPARAM(static_cast<short>(point.x), static_cast<short>(point.y));
  DWORD_PTR hit_test = HTCLIENT;
  const LRESULT hit_delivered = SendMessageTimeoutW(
      target, WM_NCHITTEST, 0, screen_point,
      SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &hit_test);
  if (hit_delivered == 0) {
    SetBool(env, result, "refreshed", false);
    SetInt(env, result, "error", GetLastError());
    return result;
  }

  DWORD_PTR ignored = 0;
  const LPARAM cursor_context = MAKELPARAM(static_cast<WORD>(hit_test), WM_MOUSEMOVE);
  const LRESULT cursor_delivered = SendMessageTimeoutW(
      target, WM_SETCURSOR, reinterpret_cast<WPARAM>(target), cursor_context,
      SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &ignored);

  SetBool(env, result, "refreshed", cursor_delivered != 0);
  SetInt(env, result, "hitTest", static_cast<int64_t>(hit_test));
  SetInt(env, result, "error", cursor_delivered != 0 ? 0 : GetLastError());
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "refreshCursorAtCurrentPoint", NAPI_AUTO_LENGTH, RefreshCursor, nullptr, &function);
  napi_set_named_property(env, exports, "refreshCursorAtCurrentPoint", function);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
