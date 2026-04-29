import os
import requests
import re
import time

class NaverSearchAPI:
    BASE_ENDPOINT = "https://openapi.naver.com/v1/search"
    
    CLIENT_ID = "ZDIQJ9gMRb_JxO8sG_pN"
    CLIENT_SECRET = "mxFniR_Bzf"

    def _get_headers(self):
        return {
            "X-Naver-Client-Id": self.CLIENT_ID,
            "X-Naver-Client-Secret": self.CLIENT_SECRET
        }

    def _get_params(self, query, page):
        start = 1000 if page == 11 else 100 * (page - 1) + 1
        return {
            "query": query,
            "display": 100,
            "start": start
        }

    def _call(self, endpoint_type, query, page=1):
        # 10페이지 - 1100 상품만 확인가능
        if page > 11:
            return True, []

        endpoint = f"{self.BASE_ENDPOINT}/{endpoint_type.lower()}.json"

        # 속도 제한 방지 (HTTP 429)
        time.sleep(0.2)
        response = requests.get(
            endpoint, 
            headers=self._get_headers(), 
            params=self._get_params(query, page)
        )

        if response.status_code == 200:
            items = response.json().get("items", [])
            if page == 10:
                items = items[1:]
            return False, items
        
        print(f"Error: {response.status_code} - {response.text}")
        return True, []


class NaverShoppingRank(NaverSearchAPI):
    def __init__(self, url):
        url = url.split('?')[0]
        self.MID = url.split('/')[-1]
        self.MALL_LINK = "/".join(url.split('/')[:4]) if "/main" not in url else ""

    def get(self, keyword, page=1, only_first_page=False):
        has_error, items = self._call("SHOP", keyword, page=page)
        if has_error:
            return None

        for index, item in enumerate(items):
            searched_mid = item["link"].split("/")[-1]
            if self.MID == searched_mid:
                item["rank"] = index + 100 * (page - 1) + 1
                item["keyword"] = keyword
                return self._form(item)

        if not only_first_page:
            return self.get(keyword, page=page + 1)

        return None

    def _form(self, item):
        item["title"] = re.sub(r"<.+?>", "", item["title"])
        item["mallLink"] = self.MALL_LINK

        rank = item.get("rank")
        if rank:
            page_ui = rank // 40 + 1
            page_rank = rank % 40
            item["rankText"] = f"{rank} 위({page_ui} 페이지 {page_rank} 위)"
            item["isCheck"] = True
        else:
            item["rankText"] = "순위 밖 (1200위 초과)"
            item["isCheck"] = False

        if item.get("mallName") == "네이버":
            item["mallName"] = "가격비교"

        return item


if __name__ == "__main__":
    import sys
    import json
    
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: python main.py <product_url> <keyword>"}))
        sys.exit(1)
    
    target_url = sys.argv[1]
    keyword = sys.argv[2]
    
    try:
        ranker = NaverShoppingRank(target_url)
        result = ranker.get(keyword)
        
        if result:
            output = {
                "success": True,
                "rank": result.get('rank'),
                "title": result.get('title'),
                "image": result.get('image')
            }
        else:
            output = {
                "success": True,
                "rank": None,
                "title": None,
                "image": None
            }
        
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
