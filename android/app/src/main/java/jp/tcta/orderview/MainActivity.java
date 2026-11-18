package jp.tcta.orderview;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Web アプリ一式 (assets/www) をそのまま抱えた WebView。
 * 通信は「新しい版が出ていないか」を見に行くときだけで、表の解析は端末内で完結する。
 */
public class MainActivity extends Activity {

  /** assets を https で配る。file:// と違って生成元が固定されるので保存した設定が残る。 */
  static final String ORIGIN = "https://appassets.androidplatform.net";
  static final String START_URL = ORIGIN + "/assets/www/index.html";
  private static final int REQ_PICK_FILE = 4101;

  /** 受信が止まったと見なすまでの時間。過ぎたらつなぎ直す。 */
  private static final long STALL_MS = 20000;
  private static final int MAX_TRIES = 3;

  private WebView web;
  private ValueCallback<Uri[]> pendingPick;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private volatile int copyGen = 0;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    web = new WebView(this);
    web.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    // 画面の文字の大きさはアプリ側の設定で決める。端末のフォント倍率と二重に掛からないようにする。
    s.setTextZoom(100);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);

    final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        return loader.shouldInterceptRequest(req.getUrl());
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        return openOutside(req.getUrl());
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
        if (pendingPick != null) pendingPick.onReceiveValue(null);
        pendingPick = cb;
        // 種類で絞り込まない。Google ドライブなどは .xlsm の種類の綴りが揃っておらず、
        // 絞り込むと肝心の発注マクロが選べなくなる。開けない中身なら読み込み時に知らせる。
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType("*/*");
        try {
          startActivityForResult(pick, REQ_PICK_FILE);
          return true;
        } catch (ActivityNotFoundException e) {
          pendingPick = null;
          Toast.makeText(MainActivity.this, "ファイルを選ぶアプリが見つかりません", Toast.LENGTH_LONG).show();
          return false;
        }
      }
    });

    web.addJavascriptInterface(new NativeBridge(this), "AndroidApp");

    // 復帰できなければ最初から読み込む (真っ白なまま残らないように)
    if (saved == null || web.restoreState(saved) == null) web.loadUrl(START_URL);
  }

  /** アプリの外へ出す URL か判定し、外なら端末のブラウザやメールに渡す。 */
  private boolean openOutside(Uri u) {
    if (u == null) return false;
    String scheme = u.getScheme();
    if (("https".equals(scheme) || "http".equals(scheme)) && START_URL.startsWith(scheme + "://" + u.getHost())) {
      return false; // assets 内の移動はそのまま WebView で
    }
    try {
      Intent i = new Intent(Intent.ACTION_VIEW, u);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(i);
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, "開けるアプリが見つかりません", Toast.LENGTH_SHORT).show();
    }
    return true;
  }

  @Override
  protected void onActivityResult(int req, int res, Intent data) {
    if (req != REQ_PICK_FILE) {
      super.onActivityResult(req, res, data);
      return;
    }
    ValueCallback<Uri[]> cb = pendingPick;
    pendingPick = null;
    if (cb == null) return;
    if (res != RESULT_OK || data == null || data.getData() == null) {
      cb.onReceiveValue(null);
      return;
    }
    // Google ドライブなどのファイルを WebView に直接読ませると、端末にまだ無いときに
    // 受信待ちのまま止まることがある。先にアプリ内へ写し取ってから渡す。
    copyThenDeliver(data.getData(), cb);
  }

  private void copyThenDeliver(final Uri src, final ValueCallback<Uri[]> cb) {
    final int gen = ++copyGen;
    progressJs("start", 0, -1, 0);
    new Thread(() -> {
      // 名前と大きさの問い合わせもクラウド側で待たされることがあるので、画面のスレッドでは行わない
      final String name = displayName(src);
      final long size = declaredSize(src);
      File dir = new File(getCacheDir(), "pick");
      File out = new File(dir, name);
      String err = null;
      for (int attempt = 1; attempt <= MAX_TRIES; attempt++) {
        if (gen != copyGen) { ui.post(() -> cb.onReceiveValue(null)); return; }
        try {
          if (!dir.exists() && !dir.mkdirs()) throw new IOException("作業用の場所を作れません");
          File[] old = dir.listFiles();
          if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
            f.delete();
          copyWithWatchdog(src, out, size, attempt, gen);
          if (out.length() == 0) throw new IOException("空のファイルです");
          if (size > 0 && out.length() != size) throw new IOException("途中までしか受け取れませんでした");
          err = null;
          break;
        } catch (Exception e) {
          err = e.getMessage() != null ? e.getMessage() : e.toString();
          if (attempt < MAX_TRIES) {
            progressJs("retry", 0, size, attempt + 1);
            try { Thread.sleep(800L * attempt); } catch (InterruptedException ie) { ui.post(() -> cb.onReceiveValue(null)); return; }
          }
        }
      }
      final String fErr = err;
      ui.post(() -> {
        if (gen != copyGen) { cb.onReceiveValue(null); return; }
        if (fErr != null && !(out.exists() && out.length() > 0)) {
          progressJs("fail", 0, size, 0);
          Toast.makeText(this, "ファイルを受け取れませんでした: " + fErr, Toast.LENGTH_LONG).show();
          cb.onReceiveValue(null);
          return;
        }
        try {
          Uri local = FileProvider.getUriForFile(this, getPackageName() + ".files", out);
          cb.onReceiveValue(new Uri[]{local});
        } catch (Exception e) {
          // 写しを渡せないときは、元の場所をそのまま渡す（従来どおり）
          cb.onReceiveValue(new Uri[]{src});
        }
      });
    }, "pick-copy").start();
  }

  /**
   * 写し取りを別スレッドで行い、受信が STALL_MS 止まったらその試行を見捨てて例外にする。
   * ドライブの「開く」自体が戻ってこない場合もあるので、待つ側はこちらで握る。
   */
  private void copyWithWatchdog(Uri src, File out, long size, int attempt, int gen) throws IOException {
    final AtomicLong last = new AtomicLong(System.currentTimeMillis());
    final AtomicBoolean abandoned = new AtomicBoolean(false);
    final InputStream[] stream = new InputStream[1];
    final IOException[] failure = new IOException[1];
    final File tmp = new File(out.getParentFile(), out.getName() + ".part" + attempt);
    Thread worker = new Thread(() -> {
      InputStream in = null;
      try {
        in = getContentResolver().openInputStream(src);
        if (in == null) throw new IOException("ファイルを開けません");
        synchronized (stream) { stream[0] = in; }
        if (abandoned.get()) return;
        last.set(System.currentTimeMillis());
        try (OutputStream os = new FileOutputStream(tmp)) {
          byte[] buf = new byte[64 * 1024];
          long total = 0, lastReport = 0;
          int n;
          while ((n = in.read(buf)) != -1) {
            if (abandoned.get() || gen != copyGen) return;
            os.write(buf, 0, n);
            total += n;
            last.set(System.currentTimeMillis());
            if (total - lastReport > 256 * 1024) {
              lastReport = total;
              progressJs("copy", total, size, attempt);
            }
          }
          progressJs("copy", total, size, attempt);
        }
      } catch (IOException e) {
        failure[0] = e;
      } catch (Exception e) {
        failure[0] = new IOException(e.toString());
      } finally {
        if (in != null) try { in.close(); } catch (IOException ignore) { }
      }
    }, "pick-copy-" + attempt);
    worker.setDaemon(true);
    worker.start();
    while (worker.isAlive()) {
      try { worker.join(500); } catch (InterruptedException e) { abandoned.set(true); throw new IOException("取り消されました"); }
      if (gen != copyGen) { abandoned.set(true); throw new IOException("取り消されました"); }
      if (worker.isAlive() && System.currentTimeMillis() - last.get() > STALL_MS) {
        abandoned.set(true);
        synchronized (stream) { if (stream[0] != null) try { stream[0].close(); } catch (Exception ignore) { } }
        //noinspection ResultOfMethodCallIgnored
        tmp.delete();
        throw new IOException("受信が止まりました");
      }
    }
    if (failure[0] != null) { //noinspection ResultOfMethodCallIgnored
      tmp.delete(); throw failure[0]; }
    if (out.exists()) //noinspection ResultOfMethodCallIgnored
      out.delete();
    if (!tmp.renameTo(out)) throw new IOException("控えを保存できません");
  }

  private void progressJs(String phase, long done, long total, int attempt) {
    final String js = "(function(){try{window.OrderViewNative&&OrderViewNative.pickProgress&&OrderViewNative.pickProgress('"
        + phase + "'," + done + "," + total + "," + attempt + ");}catch(e){}})()";
    ui.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
  }

  private String displayName(Uri u) {
    String name = null;
    try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
    } catch (Exception ignore) { }
    if (name == null || name.trim().isEmpty()) name = "book.xlsx";
    return name.replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_");
  }

  private long declaredSize(Uri u) {
    try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.SIZE}, null, null, null)) {
      if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
    } catch (Exception ignore) { }
    return -1;
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  @Override
  public void onBackPressed() {
    // 開いているシートやメニューがあれば、まずそれを閉じる。
    web.evaluateJavascript(
        "(function(){try{return !!(window.OrderViewNative && OrderViewNative.back());}catch(e){return false;}})()",
        value -> {
          if ("true".equals(value)) return;
          if (web.canGoBack()) web.goBack();
          else finish();
        });
  }

  @Override
  protected void onDestroy() {
    if (web != null) {
      web.removeJavascriptInterface("AndroidApp");
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }
}
