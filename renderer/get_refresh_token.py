"""
Google ドライブ用リフレッシュトークン取得（初回 1 回だけローカルで実行）
  1. GCP コンソールで OAuth クライアント（デスクトップアプリ）を作成し client_secret.json を保存
  2. python get_refresh_token.py
  3. 表示された値を GitHub Secrets（またはローカルの環境変数）に登録
"""
from google_auth_oauthlib.flow import InstalledAppFlow

flow = InstalledAppFlow.from_client_secrets_file("client_secret.json", ["https://www.googleapis.com/auth/drive"])
creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
print("\nGOOGLE_CLIENT_ID     =", creds.client_id)
print("GOOGLE_CLIENT_SECRET =", creds.client_secret)
print("GOOGLE_REFRESH_TOKEN =", creds.refresh_token)
