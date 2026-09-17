package jp.tcta.orderview;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Web アプリ側から呼ぶ橋渡し。
 * WebView には blob: を保存する仕組みがないので、作ったファイルはここに渡して
 * 端末の「ダウンロード」に書き出すか、共有メニューに載せる。
 *
 * 大きなブックだと数 MB になるため、文字列を一度に渡さず小分けで受け取る。
 */
public class NativeBridge {

  private final Activity act;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final Map<String, File> pending = new HashMap<>();
  private final AtomicLong seq = new AtomicLong(1);

  NativeBridge(Activity act) {
    this.act = act;
  }

  /** アプリ本体 (APK) の版。Web 側はこれで「アプリ版で動いているか」も判定する。 */
  @JavascriptInterface
  public String appVersion() {
    return BuildConfig.VERSION_NAME;
  }

  @JavascriptInterface
  public String releasePage() {
    return "https://github.com/tcta-tottori/Order/releases/latest";
  }

  /** 書き出しの受け口を用意する。戻り値はこの書き出しを指す札。 */
  @JavascriptInterface
  public String beginFile(String name) {
    try {
      File dir = new File(act.getCacheDir(), "share");
      if (!dir.exists() && !dir.mkdirs()) throw new IOException("作業用の場所を作れません");
      File f = new File(dir, safeName(name));
      if (f.exists() && !f.delete()) throw new IOException("前のファイルを消せません");
      String token = "f" + seq.getAndIncrement();
      synchronized (pending) {
        pending.put(token, f);
      }
      return token;
    } catch (IOException e) {
      return "";
    }
  }

  /** 小分けにした中身を受け取って足していく。 */
  @JavascriptInterface
  public boolean writeChunk(String token, String base64) {
    File f;
    synchronized (pending) {
      f = pending.get(token);
    }
    if (f == null) return false;
    try (FileOutputStream out = new FileOutputStream(f, true)) {
      out.write(Base64.decode(base64, Base64.DEFAULT));
      return true;
    } catch (IOException | IllegalArgumentException e) {
      return false;
    }
  }

  /**
   * 書き出しを閉じる。
   * share が true なら共有メニュー、false なら端末の「ダウンロード」に保存する。
   */
  @JavascriptInterface
  public void finishFile(String token, String mime, boolean share, String subject, String text) {
    final File f;
    synchronized (pending) {
      f = pending.remove(token);
    }
    if (f == null || !f.exists()) {
      toast("保存に失敗しました", true);
      return;
    }
    final String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
    if (share) {
      ui.post(() -> shareFile(f, type, subject, text));
    } else {
      ui.post(() -> saveToDownloads(f, type));
    }
  }

  /** 端末のブラウザなど外のアプリで開く。更新版の入手はここを通る。 */
  @JavascriptInterface
  public void openUrl(String url) {
    if (url == null || url.isEmpty()) return;
    ui.post(() -> {
      try {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        act.startActivity(i);
      } catch (Exception e) {
        toast("開けませんでした", true);
      }
    });
  }

  @JavascriptInterface
  public void toastMessage(String msg) {
    toast(msg, false);
  }

  // ---------------------------------------------------------------- 中身

  private void shareFile(File f, String mime, String subject, String text) {
    try {
      Uri uri = FileProvider.getUriForFile(act, act.getPackageName() + ".files", f);
      Intent send = new Intent(Intent.ACTION_SEND);
      send.setType(mime);
      send.putExtra(Intent.EXTRA_STREAM, uri);
      if (subject != null && !subject.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, subject);
      if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
      send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      act.startActivity(Intent.createChooser(send, "送り先を選ぶ"));
    } catch (Exception e) {
      toast("共有できませんでした", true);
    }
  }

  private void saveToDownloads(File f, String mime) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ContentResolver cr = act.getContentResolver();
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Downloads.DISPLAY_NAME, f.getName());
        cv.put(MediaStore.Downloads.MIME_TYPE, mime);
        cv.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri item = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (item == null) throw new IOException("保存先を作れません");
        try (InputStream in = new java.io.FileInputStream(f);
             OutputStream out = cr.openOutputStream(item)) {
          if (out == null) throw new IOException("保存先を開けません");
          copy(in, out);
        }
        cv.clear();
        cv.put(MediaStore.Downloads.IS_PENDING, 0);
        cr.update(item, cv, null, null);
      } else {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("保存先を作れません");
        File out = new File(dir, f.getName());
        try (InputStream in = new java.io.FileInputStream(f);
             OutputStream os = new FileOutputStream(out)) {
          copy(in, os);
        }
      }
      toast("ダウンロードに保存しました: " + f.getName(), false);
    } catch (Exception e) {
      // 保存できない端末では共有に回す。何も起きないよりは渡し先を選べたほうがよい。
      toast("保存できないため共有に切り替えます", true);
      shareFile(f, mime, "", "");
    }
  }

  private static void copy(InputStream in, OutputStream out) throws IOException {
    byte[] buf = new byte[64 * 1024];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    out.flush();
  }

  /** 端末の保存先を壊さないよう、区切り文字だけ落とす。 */
  private static String safeName(String name) {
    String n = (name == null || name.trim().isEmpty()) ? "OrderView.bin" : name.trim();
    n = n.replace('/', '_').replace('\\', '_').replace(':', '_');
    if (n.length() > 120) n = n.substring(n.length() - 120);
    return n;
  }

  private void toast(String msg, boolean isLong) {
    if (msg == null || msg.isEmpty()) return;
    ui.post(() -> Toast.makeText(act, msg, isLong ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show());
  }
}
