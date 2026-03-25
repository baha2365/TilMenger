file_path = "output.txt"

def clear_file():
    with open(file_path, "w") as f:
        pass


def write_text(text):
    with open(file_path, "a", encoding="utf-8") as file:
        file.write(text)
