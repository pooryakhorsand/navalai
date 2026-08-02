from rest_framework.response import Response
from rest_framework import status


class APIResponse:
    """
    پاسخ استاندارد سبک برای همه‌ی زیرماژول‌های holtrop.
    کلید 'success' با فرانت هماهنگه.
    """
    @staticmethod
    def success(data=None, message="OK", code=status.HTTP_200_OK):
        return Response({"success": True, "message": message, "data": data}, status=code)

    @staticmethod
    def error(message="Error", errors=None, code=status.HTTP_400_BAD_REQUEST):
        return Response({"success": False, "message": message, "errors": errors}, status=code)